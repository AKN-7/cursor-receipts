// Combined thermal printer library - single file version
// Original modules: types, escpos, network, usb, formatter, printer

import { PNG } from "pngjs";

// ===== TYPES =====

export interface MessageContent {
  name?: string;
  text?: string;
  image?: File;
  date?: string | Date;
  source?: string;
}

export interface PrinterConfig {
  ip?: string;
  useUSB?: boolean;
}

// ===== ESC/POS COMMAND BUILDER =====

export class ESCPOSEncoder {
  private buffer: Buffer[] = [];

  // Control commands
  private static readonly ESC = "\x1B";
  private static readonly GS = "\x1D";

  init(): this {
    this.buffer.push(Buffer.from(`${ESCPOSEncoder.ESC}@`));
    return this;
  }

  text(content: string): this {
    this.buffer.push(Buffer.from(content));
    return this;
  }

  newline(count = 1): this {
    this.buffer.push(Buffer.from("\n".repeat(count)));
    return this;
  }

  align(position: "left" | "center" | "right"): this {
    const codes = { left: "\x00", center: "\x01", right: "\x02" };
    this.buffer.push(Buffer.from(`${ESCPOSEncoder.ESC}a${codes[position]}`));
    return this;
  }

  bold(enabled = true): this {
    this.buffer.push(Buffer.from(`${ESCPOSEncoder.ESC}E${enabled ? "\x01" : "\x00"}`));
    return this;
  }

  size(width: number, height: number): this {
    const w = Math.max(1, Math.min(8, width)) - 1;
    const h = Math.max(1, Math.min(8, height)) - 1;
    const size = (w << 4) | h;
    this.buffer.push(Buffer.from(`${ESCPOSEncoder.GS}!${String.fromCharCode(size)}`));
    return this;
  }

  image(imageData: Buffer): this {
    this.buffer.push(imageData);
    return this;
  }

  cut(): this {
    // Epson printers use GS V A 0 for full cut
    this.buffer.push(Buffer.from(`${ESCPOSEncoder.GS}VA\x00`));
    return this;
  }

  getBuffer(): Buffer {
    return Buffer.concat(this.buffer);
  }

  clear(): this {
    this.buffer = [];
    return this;
  }
}

// ===== NETWORK ADAPTER =====

export class NetworkAdapter {
  private socket: any = null;
  private host: string;
  private port: number;
  private connected = false;

  constructor(host: string, port = 9100) {
    this.host = host;
    this.port = port;
  }

  async connect(): Promise<void> {
    if (this.connected && this.socket && !this.socket.destroyed) {
      return; // Already connected
    }

    const net = await import("net");
    this.socket = new net.Socket();

    // Set socket options for better reliability
    this.socket.setKeepAlive(true, 30000); // 30 second keepalive
    this.socket.setTimeout(10000); // 10 second timeout

    return new Promise((resolve, reject) => {
      const onConnect = () => {
        this.connected = true;
        this.socket.removeListener('error', onError);
        resolve();
      };

      const onError = (err: any) => {
        this.connected = false;
        this.socket.removeListener('connect', onConnect);
        reject(err);
      };

      this.socket.once('connect', onConnect);
      this.socket.once('error', onError);
      
      // Handle connection loss
      this.socket.on('close', () => {
        this.connected = false;
      });

      this.socket.on('end', () => {
        this.connected = false;
      });

      this.socket.connect(this.port, this.host);
    });
  }

  async write(data: Buffer): Promise<void> {
    // Try to reconnect if connection is lost
    if (!this.connected || this.socket.destroyed) {
      console.log("[🧾] Network connection lost, attempting to reconnect...");
      await this.connect();
    }

    return new Promise((resolve, reject) => {
      const onError = (err: any) => {
        this.connected = false;
        
        // If it's a connection error, try once to reconnect and retry
        if (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'ENOTCONN') {
          console.log(`[🧾] Connection error (${err.code}), attempting recovery...`);
          
          // Try to reconnect and retry once
          this.connect()
            .then(() => {
              console.log("[🧾] Reconnected, retrying write...");
              return this.writeInternal(data);
            })
            .then(resolve)
            .catch(reject);
        } else {
          reject(err);
        }
      };

      this.socket.once('error', onError);
      this.writeInternal(data)
        .then(() => {
          this.socket.removeListener('error', onError);
          resolve();
        })
        .catch(() => {
          this.socket.removeListener('error', onError);
          onError(new Error('Write failed'));
        });
    });
  }

  private async writeInternal(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(data, (err: any) => {
        if (err) {
          reject(err);
          return;
        }
        
        // Ensure data is flushed to the printer
        if (this.socket.writableNeedDrain) {
          // Add timeout for drain event
          const drainTimeout = setTimeout(() => {
            resolve();
          }, 5000); // 5 second timeout
          
          this.socket.once('drain', () => {
            clearTimeout(drainTimeout);
            resolve();
          });
        } else {
          resolve();
        }
      });
    });
  }

  close(): void {
    this.connected = false;
    this.socket?.destroy();
  }
}

// ===== USB ADAPTER =====
// USB Setup Requirements:
// • Linux: Install libudev-dev (Ubuntu/Debian: sudo apt-get install build-essential libudev-dev)
// • macOS: Should work out of the box
// • Windows: Use Zadig to install WinUSB driver for your USB device
// • Without proper drivers, you'll get LIBUSB_ERROR_NOT_SUPPORTED when opening devices

let usb: any = null;
let USB_AVAILABLE = false;

try {
  const usbModule = require("usb");
  usb = usbModule.usb;
  USB_AVAILABLE = true;
} catch (error) {
  console.log("[🧾] USB module not available, install with: bun add usb");
  USB_AVAILABLE = false;
}

export class USBAdapter {
  private device: any = null;
  private endpoint: any = null;
  private interface: any = null;

  constructor() {
    if (!USB_AVAILABLE) {
      throw new Error("USB not available. Install with: bun add usb");
    }

    // Find first printer device
    const devices = usb.getDeviceList();
    
    for (const device of devices) {
      try {
        if (this.isPrinter(device)) {
          this.device = device;
          break;
        }
      } catch (e) {
        // Skip devices that can't be read
      }
    }

    if (!this.device) {
      throw new Error("No USB printer found");
    }
  }

  private isPrinter(device: any): boolean {
    try {
      const descriptor = device.deviceDescriptor;
      const vendorId = descriptor.idVendor;
      
      // Check for known thermal printer vendors
      const thermalPrinterVendors = [
        0x04b8, // Epson
        0x0456, // Analog Devices
        0x0416, // Winbond Electronics
        0x0519, // Star Micronics
        0x0DD4  // Custom
      ];
      
      if (thermalPrinterVendors.includes(vendorId)) {
        return true;
      }
      
      const config = device.configDescriptor;
      if (!config?.interfaces) {
        return false;
      }

      for (const iface of config.interfaces) {
        for (const setting of iface) {
          // Check for printer class (7) or vendor-specific (255) which some thermal printers use
          if (setting.bInterfaceClass === 7 || setting.bInterfaceClass === 255) {
            return true;
          }
        }
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  async connect(): Promise<void> {
    this.device.open();
    
    const config = this.device.configDescriptor;
    for (const iface of config.interfaces) {
      const setting = iface[0];
      
      // Accept printer class (7) or vendor-specific (255)
      if (setting.bInterfaceClass === 7 || setting.bInterfaceClass === 255) {
        try {
          this.interface = this.device.interface(setting.bInterfaceNumber);
          this.interface.claim();
          
          const outEndpoint = setting.endpoints.find((ep: any) => (ep.bEndpointAddress & 0x80) === 0);
          if (outEndpoint) {
            this.endpoint = this.interface.endpoint(outEndpoint.bEndpointAddress);
            return;
          }
        } catch (e) {
          continue;
        }
      }
    }

    throw new Error("No usable endpoint found");
  }

  async write(data: Buffer): Promise<void> {
    console.log(`[🧾] USB write: sending ${data.length} bytes`);
    console.log(`[🧾] USB write first 32 bytes:`, Array.from(data.slice(0, 32)).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(' '));
    if (data.length > 32) {
      console.log(`[🧾] USB write last 32 bytes:`, Array.from(data.slice(-32)).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(' '));
    }
    
    // Send the main data
    await new Promise<void>((resolve, reject) => {
      const startTime = Date.now();
      this.endpoint.transfer(data, (error: any) => {
        const duration = Date.now() - startTime;
        if (error) {
          console.error(`[🧾] USB transfer failed after ${duration}ms:`, error);
          reject(error);
        } else {
          console.log(`[🧾] USB transfer completed in ${duration}ms`);
          resolve();
        }
      });
    });
    
    // Give the printer time to process the data
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  close(): void {
    try {
      this.interface?.release();
    } catch (e) {
      // Ignore release errors
    }
    try {
      this.device?.close();
    } catch (e) {
      // Ignore close errors
    }
  }
}

export { USB_AVAILABLE };

// ===== MESSAGE FORMATTER =====

export class MessageFormatter {
	private encoder = new ESCPOSEncoder();

	async formatMessage(content: MessageContent): Promise<Buffer> {
		this.encoder.clear();

		// Initialize
		this.encoder.init();

		// Format date
		const dateToFormat = content.date ? new Date(content.date) : new Date();
		const formattedDateTime = dateToFormat.toLocaleString("en-US", {
			year: "numeric",
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
			hour12: true,
			timeZone: "America/New_York",
		});

		// Auto-set source to "voicemail" if date is provided but source isn't
		const source =
			content.date && !content.source ? "voicemail" : content.source;

		// Date header with source
		const headerText = source
			? `${formattedDateTime} (${source})`
			: formattedDateTime;

		this.encoder.align("left").bold(true).text(headerText).newline();

		// Name section (no "From:" prefix)
		if (content.name) {
			this.encoder.text(this.normalizeText(content.name)).newline();
		}

		this.encoder.bold(false).newline();

		// Text content with wrapping
		if (content.text) {
			this.encoder.align("left");
			const wrappedText = this.wrapText(content.text, 48);
			this.encoder.text(wrappedText).newline(2);
		}

		// Image processing
		if (content.image) {
			try {
				console.log("[🧾] Starting image processing...");
				const imageData = await Promise.race([
					this.processImage(content.image),
					new Promise<Buffer>((_, reject) => 
						setTimeout(() => reject(new Error("Image processing timeout after 15 seconds")), 15000)
					)
				]);
				console.log("[🧾] Image processed, adding to print buffer...");
				this.encoder.align("left");        // critical!
				this.encoder.text("\n");           // one empty line before image
				this.encoder.image(imageData);
				console.log("[🧾] Image added to buffer");
			} catch (error: any) {
				console.error("[🧾] Image processing failed:", error?.message || error);
				this.encoder.align("center").text(`[Image Error: ${error?.message || "Unknown"}]`).newline(2);
			}
		}

		// Footer
		this.encoder.newline(3).cut();

		return this.encoder.getBuffer();
	}

	private normalizeText(text: string): string {
		return text
			.replace(/[""]/g, '"')
			.replace(/['']/g, "'")
			.replace(/[–—]/g, "-")
			.replace(/…/g, "...");
	}

	private wrapText(text: string, width: number): string {
		// Normalize Unicode characters first
		text = this.normalizeText(text);

		const words = text.split(" ");
		const lines: string[] = [];
		let currentLine = "";

		for (const word of words) {
			const testLine = currentLine ? `${currentLine} ${word}` : word;
			if (testLine.length <= width) {
				currentLine = testLine;
			} else {
				if (currentLine) lines.push(currentLine);
				currentLine = word;
			}
		}

		if (currentLine) lines.push(currentLine);
		return lines.join("\n");
	}

	private async processImage(imageFile: File): Promise<Buffer> {
		console.log("[🧾] Processing image, size:", imageFile.size, "type:", imageFile.type);
		
		// Convert File to Buffer
		const arrayBuffer = await imageFile.arrayBuffer();
		let buffer = Buffer.from(arrayBuffer);
		console.log("[🧾] Image buffer created, first 16 bytes:", Array.from(buffer.slice(0, 16)).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(' '));
		
		// Parse PNG (pngjs can handle some formats, but let's be explicit)
		let png: PNG;
		try {
			png = PNG.sync.read(buffer);
			console.log("[🧾] PNG parsed, dimensions:", png.width, "x", png.height);
			console.log("[🧾] PNG data length:", png.data.length, "bytes (expected:", png.width * png.height * 4, ")");
			
			// Sample some pixel values from the image
			const samplePixels = [
				[0, 0], [png.width - 1, 0], [0, png.height - 1], 
				[Math.floor(png.width/2), Math.floor(png.height/2)]
			];
			console.log("[🧾] Sample pixel values:");
			for (const [x, y] of samplePixels) {
				const idx = (y * png.width + x) * 4;
				if (idx + 3 < png.data.length) {
					const r = png.data[idx];
					const g = png.data[idx + 1];
					const b = png.data[idx + 2];
					const a = png.data[idx + 3];
					const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
					console.log(`[🧾]   Pixel [${x}, ${y}]: RGBA(${r},${g},${b},${a}) -> gray=${gray}`);
				}
			}
		} catch (error) {
			console.error("[🧾] Failed to parse as PNG:", error);
			// If it's not PNG, we need to convert it - but pngjs only handles PNG
			// For now, reject non-PNG images
			throw new Error("Image must be PNG format. Please convert your image to PNG first.");
		}
		
		// Resize if too large (thermal printers are usually 384px wide max)
		const MAX_WIDTH = 384;
		if (png.width > MAX_WIDTH) {
			const scale = MAX_WIDTH / png.width;
			const newWidth = MAX_WIDTH;
			const newHeight = Math.floor(png.height * scale);
			console.log(`[🧾] Resizing image from ${png.width}x${png.height} to ${newWidth}x${newHeight}`);
			
			// Simple nearest-neighbor resize
			const resized = new PNG({ width: newWidth, height: newHeight });
			for (let y = 0; y < newHeight; y++) {
				for (let x = 0; x < newWidth; x++) {
					const srcX = Math.floor(x / scale);
					const srcY = Math.floor(y / scale);
					const srcIdx = (srcY * png.width + srcX) * 4;
					const dstIdx = (y * newWidth + x) * 4;
					
					if (srcIdx + 3 < png.data.length && dstIdx + 3 < resized.data.length) {
						resized.data[dstIdx] = png.data[srcIdx];
						resized.data[dstIdx + 1] = png.data[srcIdx + 1];
						resized.data[dstIdx + 2] = png.data[srcIdx + 2];
						resized.data[dstIdx + 3] = png.data[srcIdx + 3];
					}
				}
			}
			png = resized;
			console.log("[🧾] Resize complete");
		}

		// Convert to ESC/POS bitmap
		console.log("[🧾] Converting to bitmap...");
		const result = this.convertToBitmap(png);
		console.log("[🧾] Bitmap conversion complete, size:", result.length, "bytes");
		return result;
	}

	private convertToBitmap(png: PNG): Buffer {
		const { width, height, data } = png;

		const bytesPerLine = Math.ceil(width / 8);
		const bitmap = Buffer.alloc(bytesPerLine * height);

		for (let y = 0; y < height; y++) {
			for (let x = 0; x < bytesPerLine; x++) {
				let byte = 0;
				for (let b = 0; b < 8; b++) {
					const px = x * 8 + b;
					if (px >= width) continue;
					const idx = (y * width + px) * 4;
					const r = data[idx];
					const alpha = data[idx + 3];
					// Black if dark AND opaque
					const isBlack = alpha > 128 && r < 128;
					if (isBlack) byte |= (0x80 >> b);   // MSB first (correct for Epson)
				}
				bitmap[y * bytesPerLine + x] = byte;
			}
		}

		// GS v 0 command — EXACT sequence Epson wants
		const header = Buffer.from([
			0x1D, 0x76, 0x30, 0x00,        // GS v 0 mode 0
			bytesPerLine & 0xFF,            // xL
			bytesPerLine >> 8,              // xH
			height & 0xFF,                  // yL
			height >> 8                     // yH
		]);

		return Buffer.concat([header, bitmap]);
	}
}

// ===== PRINTER =====

export class Printer {
  private adapter: USBAdapter | NetworkAdapter | null = null;
  private formatter = new MessageFormatter();
  private config: PrinterConfig;
  private initialized = false;

  constructor(config: PrinterConfig = {}) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      if (this.config.ip) {
        // Network printer specified
        this.adapter = new NetworkAdapter(this.config.ip);
        await this.adapter.connect();
        console.log(`[🧾] Network printer connected (${this.config.ip})`);
      } else {
        // Try USB first (default)
        try {
          this.adapter = new USBAdapter();
          await this.adapter.connect();
          console.log("[🧾] USB printer connected");
        } catch (usbError) {
          console.log("[🧾] USB failed:", (usbError as Error).message);
          if (this.config.useUSB === false) {
            throw new Error("USB disabled and no IP provided. Use --ip=<address> or enable USB");
          }
          throw new Error("USB printer not found. Make sure printer is connected via USB.");
        }
      }

      this.initialized = true;
    } catch (error) {
      console.error("[🧾] Failed to initialize printer:", error);
      throw error;
    }
  }

  async printMessage(content: MessageContent): Promise<void> {
    await this.ensureInitialized();

    console.log(`[🧾] Formatting message...`);
    const commands = await this.formatter.formatMessage(content);
    console.log(`[🧾] Message formatted, total size: ${commands.length} bytes`);
    console.log(`[🧾] Command breakdown:`);
    console.log(`[🧾]   First 50 bytes:`, Array.from(commands.slice(0, 50)).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(' '));
    if (commands.length > 50) {
      console.log(`[🧾]   Last 50 bytes:`, Array.from(commands.slice(-50)).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(' '));
    }
    
    console.log(`[🧾] Writing to printer adapter...`);
    await this.adapter!.write(commands);
    console.log(`[🧾] Write completed`);

    const size = commands.length < 100 
        ? `${commands.length}B`
        : `${(commands.length / 1024).toFixed(1)}KB`;
      console.log(`[🧾] Message printed (${size})`);
  }

  async getStatus(): Promise<{ online: boolean }> {
    return { online: this.initialized };
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  async close(): Promise<void> {
    this.adapter?.close();
    this.adapter = null;
    this.initialized = false;
  }
}

// ===== MAIN API =====
// Global instance
let printerInstance: Printer | null = null;

export function createPrinter(config: PrinterConfig = {}): Printer {
  if (!printerInstance) {
    printerInstance = new Printer(config);
  }
  return printerInstance;
}

