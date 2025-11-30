import { execSync } from "child_process";
import { serve } from "bun";
import { PNG } from "pngjs";
import sharp from "sharp";
import { readFileSync, existsSync } from "fs";
import { join, extname } from "path";

interface PrintJob {
  name?: string;
  text?: string;
  image?: {
    name: string;
    type: string;
    data: Buffer;
  };
}

let queue: PrintJob[] = [];

// Load logo once at startup
let logoBuffer: Buffer | null = null;
const logoPath = join(process.cwd(), "assets", "logo.png");
if (existsSync(logoPath)) {
  try {
    logoBuffer = readFileSync(logoPath);
    console.log("[LOGO] Logo loaded from assets/logo.png");
  } catch (err: any) {
    console.warn("[LOGO] Failed to load logo:", err?.message || err);
  }
} else {
  console.log("[LOGO] No logo found at assets/logo.png (optional - skipping)");
  console.log("[LOGO] To add a logo, place logo.png in the assets/ folder");
}

async function processLogo(imageData: Buffer): Promise<Buffer> {
  console.log("[LOGO] Processing logo buffer:", imageData.length, "bytes");
  
  // Get image metadata first to check orientation and dimensions
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(imageData).metadata();
    console.log("[LOGO] Original metadata:", {
      width: metadata.width,
      height: metadata.height,
      orientation: metadata.orientation,
      format: metadata.format
    });
  } catch (err: any) {
    console.error("[LOGO] Failed to read metadata:", err?.message || err);
    throw new Error(`Failed to read logo metadata: ${err?.message || err}`);
  }
  
  // Logo max width - smaller than printer width but bigger than before (about 43% of printer width)
  const maxLogoWidth = 250;
  
  // Use sharp to handle rotation, resizing, and conversion all in one go
  let pngBuffer: Buffer;
  try {
    console.log("[LOGO] Processing with sharp (rotation + resize + convert)...");
    
    let sharpInstance = sharp(imageData)
      .rotate(); // Auto-rotates based on EXIF orientation
    
    // Get dimensions after rotation
    const rotatedMetadata = await sharpInstance.metadata();
    const isPortrait = (rotatedMetadata.height || 0) > (rotatedMetadata.width || 0);
    
    console.log(`[LOGO] After rotation: ${rotatedMetadata.width}x${rotatedMetadata.height} (${isPortrait ? 'PORTRAIT' : 'LANDSCAPE'})`);
    
    // Scale logo to maxLogoWidth, preserving aspect ratio
    console.log(`[LOGO] Scaling logo to max ${maxLogoWidth}px width (preserving aspect ratio)`);
    sharpInstance = sharpInstance.resize(maxLogoWidth, null, {
      withoutEnlargement: false,
      fit: 'inside' // Preserves aspect ratio
    });
    
    // Convert to PNG
    pngBuffer = await sharpInstance.png().toBuffer();
    console.log("[LOGO] Final processed logo:", pngBuffer.length, "bytes");
  } catch (err: any) {
    console.error("[LOGO] Sharp processing failed:", err?.message || err);
    throw new Error(`Failed to process logo: ${err?.message || err}`);
  }
  
  // Decode PNG
  let png: PNG;
  try {
    png = PNG.sync.read(pngBuffer);
    console.log("[LOGO] PNG decoded - FINAL SIZE:", png.width, "x", png.height);
  } catch (err: any) {
    console.error("[LOGO] PNG decode failed:", err?.message || err);
    throw new Error(`Failed to decode logo PNG: ${err?.message || err}`);
  }
  
  // Convert to bitmap with Floyd-Steinberg dithering
  const { width, height, data } = png;
  const bytesPerRow = Math.ceil(width / 8);
  
  // Step 1: Convert RGBA to grayscale array
  const grayscale = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const alpha = data[idx + 3];
      
      if (alpha < 128) {
        // Transparent = white (255)
        grayscale[y * width + x] = 255;
      } else {
        // Grayscale conversion (0-255)
        let gray = 0.299 * r + 0.587 * g + 0.114 * b;
        // Increase contrast to make blacks darker - apply power curve
        // Darken values below 128 more aggressively
        gray = gray < 128 ? Math.pow(gray / 128, 1.5) * 128 : gray;
        grayscale[y * width + x] = Math.max(0, Math.min(255, gray));
      }
    }
  }
  
  // Step 2: Apply Floyd-Steinberg dithering
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const oldPixel = grayscale[idx];
      // Lower threshold (140) to make blacks more black - more pixels become black
      const newPixel = oldPixel < 140 ? 0 : 255;
      grayscale[idx] = newPixel;
      const error = oldPixel - newPixel;
      
      if (x + 1 < width) {
        grayscale[idx + 1] += error * (7 / 16);
      }
      if (x > 0 && y + 1 < height) {
        grayscale[idx + width - 1] += error * (3 / 16);
      }
      if (y + 1 < height) {
        grayscale[idx + width] += error * (5 / 16);
      }
      if (x + 1 < width && y + 1 < height) {
        grayscale[idx + width + 1] += error * (1 / 16);
      }
    }
  }
  
  // Step 3: Convert dithered grayscale to 1bpp bitmap (MSB first)
  const bitmap = Buffer.alloc(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const isBlack = grayscale[idx] < 128;
      
      if (isBlack) {
        const byteIndex = y * bytesPerRow + Math.floor(x / 8);
        const bitIndex = 7 - (x % 8); // MSB first
        bitmap[byteIndex] |= 1 << bitIndex;
      }
    }
  }
  
  // GS v 0 command: GS v 0 m xL xH yL yH [bitmap]
  const xL = bytesPerRow & 0xff;
  const xH = (bytesPerRow >> 8) & 0xff;
  const yL = height & 0xff;
  const yH = (height >> 8) & 0xff;
  const m = 0x00; // normal mode
  
  const header = Buffer.from([
    0x1D, 0x76, 0x30, m,    // GS v 0 m
    xL, xH, yL, yH          // width (bytes), height (dots)
  ]);
  
  return Buffer.concat([header, bitmap]);
}

async function processImage(imageData: Buffer): Promise<Buffer> {
  console.log("[IMAGE] Processing image buffer:", imageData.length, "bytes");
  
  // Get image metadata first to check orientation and dimensions
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(imageData).metadata();
    console.log("[IMAGE] Original metadata:", {
      width: metadata.width,
      height: metadata.height,
      orientation: metadata.orientation,
      format: metadata.format
    });
  } catch (err: any) {
    console.error("[IMAGE] Failed to read metadata:", err?.message || err);
    throw new Error(`Failed to read image metadata: ${err?.message || err}`);
  }
  
  // Printer width (thermal printers - this one is 576px wide)
  const printerWidth = 576;
  
  // Use sharp to handle rotation, resizing, and conversion all in one go
  // This ensures high-quality scaling and proper EXIF orientation handling
  let pngBuffer: Buffer;
  try {
    console.log("[IMAGE] Processing with sharp (rotation + resize + convert)...");
    
    let sharpInstance = sharp(imageData)
      .rotate(); // Auto-rotates based on EXIF orientation (fixes iPhone rotation)
    
    // Get dimensions after rotation to determine orientation
    const rotatedMetadata = await sharpInstance.metadata();
    const isPortrait = (rotatedMetadata.height || 0) > (rotatedMetadata.width || 0);
    
    console.log(`[IMAGE] After rotation: ${rotatedMetadata.width}x${rotatedMetadata.height} (${isPortrait ? 'PORTRAIT' : 'LANDSCAPE'})`);
    
    // Resize logic: Always preserve aspect ratio
    // - Portrait: Scale to fill width (576px), height scales proportionally
    // - Landscape: Scale to fit width (576px), height scales proportionally
    if (isPortrait) {
      // Portrait: Scale to printer width, maintain aspect ratio
      console.log(`[IMAGE] Portrait image: scaling to ${printerWidth}px width (preserving aspect ratio)`);
      sharpInstance = sharpInstance.resize(printerWidth, null, {
        withoutEnlargement: false,
        fit: 'inside' // Preserves aspect ratio
      });
    } else {
      // Landscape: Scale to fit width, maintain aspect ratio
      console.log(`[IMAGE] Landscape image: scaling to ${printerWidth}px width (preserving aspect ratio)`);
      sharpInstance = sharpInstance.resize(printerWidth, null, {
        withoutEnlargement: false,
        fit: 'inside' // Preserves aspect ratio
      });
    }
    
    // Convert to PNG
    pngBuffer = await sharpInstance.png().toBuffer();
    console.log("[IMAGE] Final processed image:", pngBuffer.length, "bytes");
  } catch (err: any) {
    console.error("[IMAGE] Sharp processing failed:", err?.message || err);
    throw new Error(`Failed to process image: ${err?.message || err}`);
  }
  
  // Decode PNG
  let png: PNG;
  try {
    png = PNG.sync.read(pngBuffer);
    console.log("[IMAGE] PNG decoded - FINAL SIZE:", png.width, "x", png.height);
    console.log(`[IMAGE] Width matches printer width: ${png.width === printerWidth ? 'YES ✓' : `NO ✗ (${png.width}px vs ${printerWidth}px)`}`);
  } catch (err: any) {
    console.error("[IMAGE] PNG decode failed:", err?.message || err);
    throw new Error(`Failed to decode PNG: ${err?.message || err}`);
  }
  
  // Convert to bitmap with Floyd-Steinberg dithering for better grayscale simulation
  const { width, height, data } = png;
  const bytesPerRow = Math.ceil(width / 8);
  
  // Step 1: Convert RGBA to grayscale array
  const grayscale = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const alpha = data[idx + 3];
      
      if (alpha < 128) {
        // Transparent = white (255)
        grayscale[y * width + x] = 255;
      } else {
        // Grayscale conversion (0-255)
        let gray = 0.299 * r + 0.587 * g + 0.114 * b;
        // Increase contrast to make blacks darker - apply power curve
        // Darken values below 128 more aggressively
        gray = gray < 128 ? Math.pow(gray / 128, 1.5) * 128 : gray;
        grayscale[y * width + x] = Math.max(0, Math.min(255, gray));
      }
    }
  }
  
  // Step 2: Apply Floyd-Steinberg dithering
  // This distributes quantization errors to neighboring pixels
  // to create the illusion of grayscale with only black/white pixels
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const oldPixel = grayscale[idx];
      
      // Quantize to black (0) or white (255)
      // Lower threshold (140) to make blacks more black - more pixels become black
      const newPixel = oldPixel < 140 ? 0 : 255;
      grayscale[idx] = newPixel;
      
      // Calculate quantization error
      const error = oldPixel - newPixel;
      
      // Distribute error to neighboring pixels (Floyd-Steinberg weights)
      if (x + 1 < width) {
        grayscale[idx + 1] += error * (7 / 16); // Right
      }
      if (x > 0 && y + 1 < height) {
        grayscale[idx + width - 1] += error * (3 / 16); // Bottom-left
      }
      if (y + 1 < height) {
        grayscale[idx + width] += error * (5 / 16); // Bottom
      }
      if (x + 1 < width && y + 1 < height) {
        grayscale[idx + width + 1] += error * (1 / 16); // Bottom-right
      }
    }
  }
  
  // Step 3: Convert dithered grayscale to 1bpp bitmap (MSB first)
  const bitmap = Buffer.alloc(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const isBlack = grayscale[idx] < 128;
      
      if (isBlack) {
        const byteIndex = y * bytesPerRow + Math.floor(x / 8);
        const bitIndex = 7 - (x % 8); // MSB first
        bitmap[byteIndex] |= 1 << bitIndex;
      }
    }
  }
  
  // GS v 0 command: GS v 0 m xL xH yL yH [bitmap]
  const xL = bytesPerRow & 0xff;
  const xH = (bytesPerRow >> 8) & 0xff;
  const yL = height & 0xff;
  const yH = (height >> 8) & 0xff;
  const m = 0x00; // normal mode
  
  const header = Buffer.from([
    0x1D, 0x76, 0x30, m,    // GS v 0 m
    xL, xH, yL, yH          // width (bytes), height (dots)
  ]);
  
  return Buffer.concat([header, bitmap]);
}

async function print(job: PrintJob) {
  try {
    console.log("[PRINT] Starting print job:", {
      hasName: !!job.name,
      hasText: !!job.text,
      hasImage: !!job.image,
      imageName: job.image?.name,
      imageSize: job.image?.size
    });
    
    // Build ESC/POS command buffer
    const parts: Buffer[] = [];
    
    // Initialize printer
    parts.push(Buffer.from([0x1b, 0x40])); // ESC @
    
    // Order: Name+Logo (if name exists) or Logo (if no name) → Text → Image
    
    // 1. Handle name and logo positioning
    if (job.name && logoBuffer && job.image) {
      // If name exists: name on left, logo on right (same line)
      try {
        console.log("[PRINT] Adding name with logo on same line...");
        
        // Name: Bold, larger, left-aligned - FIXED POSITION
        parts.push(Buffer.from([0x1b, 0x61, 0x00])); // Left align
        parts.push(Buffer.from([0x1b, 0x45, 0x01])); // Bold ON
        parts.push(Buffer.from([0x1d, 0x21, 0x11])); // Double height + width (GS !)
        parts.push(Buffer.from(job.name));
        parts.push(Buffer.from([0x1d, 0x21, 0x00])); // Normal size
        parts.push(Buffer.from([0x1b, 0x45, 0x00])); // Bold OFF
        
        // Logo: Position independently on right side using absolute positioning
        // Printer width is 576 dots, logo is max 250px wide
        // Position logo at ~320 dots from left (right side)
        const logoPosition = 320;
        const logoPosL = logoPosition & 0xFF;
        const logoPosH = (logoPosition >> 8) & 0xFF;
        parts.push(Buffer.from([0x1B, 0x24, logoPosL, logoPosH])); // ESC $ - absolute horizontal position
        
        const logoData = await processLogo(logoBuffer);
        console.log("[PRINT] Logo processed, ESC/POS size:", logoData.length, "bytes");
        parts.push(logoData);
        
        // Reset alignment to left
        parts.push(Buffer.from([0x1b, 0x61, 0x00])); // ESC a 0 (left)
        parts.push(Buffer.from("\n")); // Minimal spacing after
      } catch (logoErr: any) {
        console.error("[PRINT] Logo processing failed:", logoErr?.message || logoErr);
        // Fallback: just print name if logo fails
        parts.push(Buffer.from([0x1b, 0x61, 0x00])); // Left align
        parts.push(Buffer.from([0x1b, 0x45, 0x01])); // Bold ON
        parts.push(Buffer.from([0x1d, 0x21, 0x11])); // Double height + width
        parts.push(Buffer.from(job.name));
        parts.push(Buffer.from([0x1d, 0x21, 0x00])); // Normal size
        parts.push(Buffer.from([0x1b, 0x45, 0x00])); // Bold OFF
        parts.push(Buffer.from("\n"));
      }
    } else if (!job.name && logoBuffer && job.image) {
      // If no name but logo exists: center the logo
      try {
        console.log("[PRINT] Adding centered logo (no name)...");
        
        // Center the logo
        parts.push(Buffer.from([0x1b, 0x61, 0x01])); // ESC a 1 (center)
        
        const logoData = await processLogo(logoBuffer);
        console.log("[PRINT] Logo processed, ESC/POS size:", logoData.length, "bytes");
        parts.push(logoData);
        
        // Reset alignment to left after logo
        parts.push(Buffer.from([0x1b, 0x61, 0x00])); // ESC a 0 (left)
        parts.push(Buffer.from("\n")); // Minimal spacing after logo
      } catch (logoErr: any) {
        console.error("[PRINT] Logo processing failed:", logoErr?.message || logoErr);
        // Continue even if logo fails
      }
    } else if (job.name) {
      // If name exists but no logo: just print name (left-aligned)
      parts.push(Buffer.from([0x1b, 0x61, 0x00])); // Left align
      parts.push(Buffer.from([0x1b, 0x45, 0x01])); // Bold ON
      parts.push(Buffer.from([0x1d, 0x21, 0x11])); // Double height + width (GS !)
      parts.push(Buffer.from(job.name));
      parts.push(Buffer.from([0x1d, 0x21, 0x00])); // Normal size
      parts.push(Buffer.from([0x1b, 0x45, 0x00])); // Bold OFF
      parts.push(Buffer.from("\n"));
    }
    
    // 2. Add text (between logo/name and image) - styled for café receipts
    if (job.text) {
      
      // Text: Normal size, left aligned
      if (job.text) {
        parts.push(Buffer.from(job.text));
        parts.push(Buffer.from("\n"));
      }
      
      console.log("[PRINT] Added styled text");
    }
    
    // 3. Add image last
    if (job.image) {
      console.log("[PRINT] Processing image:", job.image.name, job.image.data.length, "bytes");
      try {
        // Center the image using ESC/POS alignment command
        // ESC a 1 = center alignment
        parts.push(Buffer.from([0x1b, 0x61, 0x01])); // ESC a 1 (center)
        
        const imageData = await processImage(job.image.data);
        console.log("[PRINT] Image processed, ESC/POS size:", imageData.length, "bytes");
        parts.push(imageData);
        
        // Reset alignment to left after image
        parts.push(Buffer.from([0x1b, 0x61, 0x00])); // ESC a 0 (left)
        parts.push(Buffer.from("\n\n\n")); // Spacing after image for tear-off
      } catch (imgErr: any) {
        console.error("[PRINT] Image processing failed:", imgErr?.message || imgErr);
        console.error("[PRINT] Error stack:", imgErr?.stack);
        parts.push(Buffer.from("\n[Image processing error]\n"));
      }
    }
    
    // Add newlines at end before cut
    parts.push(Buffer.from("\n\n\n"));
    
    // Autocutter: Full cut (ESC i)
    parts.push(Buffer.from([0x1B, 0x69])); // ESC i - Full cut
    
    // Combine all parts
    const command = Buffer.concat(parts);
    console.log("[PRINT] Total command size:", command.length, "bytes");
    
    // Send through lp -o raw
    console.log("[PRINT] Sending to printer...");
    execSync(`cat | lp -d EPSON_TM_T20II -o raw`, { input: command });
    console.log("[PRINT] ✓ Print command sent successfully");
    
    const preview = job.text?.slice(0, 50).replace(/\n/g, " ") || job.image ? "[image]" : "blank";
    console.log("PRINTED:", preview);
  } catch (err: any) {
    console.error("[PRINT] Print error:", err?.message || err);
    console.error("[PRINT] Error stack:", err?.stack);
  }
}

setInterval(async () => {
  if (queue.length > 0) {
    console.log("[QUEUE] ===== QUEUE PROCESSOR =====");
    console.log("[QUEUE] Processing queue,", queue.length, "job(s) waiting");
    const job = queue.shift()!;
    console.log("[QUEUE] Job details:", {
      hasName: !!job.name,
      hasText: !!job.text,
      hasImage: !!job.image,
      imageName: job.image?.name
    });
    await print(job);
    console.log("[QUEUE] ===== QUEUE PROCESSOR COMPLETE =====");
  }
}, 8000);   // one print every 8 sec = perfect pace

serve({
  port: 9999,
  async fetch(req) {
    const url = new URL(req.url);
    console.log("[HTTP] ===== REQUEST =====");
    console.log("[HTTP] Method:", req.method);
    console.log("[HTTP] Path:", url.pathname);
    console.log("[HTTP] URL:", req.url);
    console.log("[HTTP] Origin:", req.headers.get("origin"));
    console.log("[HTTP] User-Agent:", req.headers.get("user-agent"));
    
    // CORS headers to allow requests from Vercel and any origin
    const origin = req.headers.get("origin");
    const corsHeaders: Record<string, string> = {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, ngrok-skip-browser-warning",
      "ngrok-skip-browser-warning": "true"
    };
    
    // Set origin - use actual origin if provided, otherwise allow all
    if (origin) {
      corsHeaders["Access-Control-Allow-Origin"] = origin;
      corsHeaders["Access-Control-Allow-Credentials"] = "true";
    } else {
      corsHeaders["Access-Control-Allow-Origin"] = "*";
    }
    
    // Handle preflight requests
    if (req.method === "OPTIONS") {
      console.log("[HTTP] Handling OPTIONS preflight request");
      return new Response(null, { 
        status: 204,
        headers: corsHeaders 
      });
    }
    
    // Handle POST /chat first (before GET route catches it)
    if (url.pathname === "/chat" && req.method === "POST") {
      console.log("[HTTP] ✓ POST /chat route matched");
      console.log("[HTTP] Content-Type:", req.headers.get("content-type"));
      console.log("[HTTP] Content-Length:", req.headers.get("content-length"));
      
      try {
        console.log("[HTTP] Starting formData() parse...");
        const fd = await Promise.race([
          req.formData(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error("formData() timeout after 10s")), 10000)
          )
        ]) as FormData;
        console.log("[HTTP] ✓ Form data parsed successfully");
        
        const name = fd.get("name") as string | null;
        const text = fd.get("text") as string | null;
        const image = fd.get("image") as File | null;
        
        console.log("[QUEUE] ===== FORM SUBMISSION =====");
        console.log("[QUEUE] Received form data:", {
          name: name || "(none)",
          text: text || "(none)",
          hasImage: !!image,
          imageName: image?.name,
          imageSize: image?.size,
          imageType: image?.type
        });
        
        // Convert File to Buffer if present (File objects don't serialize well in queues)
        let imageData: { name: string; type: string; data: Buffer } | undefined;
        if (image && image.size > 0) {
          try {
            console.log("[QUEUE] Converting image File to Buffer...");
            const arrayBuffer = await image.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            console.log("[QUEUE] ✓ Image converted to buffer:", buffer.length, "bytes");
            imageData = {
              name: image.name,
              type: image.type,
              data: buffer
            };
          } catch (err: any) {
            console.error("[QUEUE] ✗ Failed to convert image:", err?.message || err);
            console.error("[QUEUE] Error stack:", err?.stack);
          }
        }
        
        const job: PrintJob = {
          name: name || undefined,
          text: text || undefined,
          image: imageData,
        };
        
        if (!job.text && !job.image) {
          job.text = "blank print";
        }
        
        console.log("[QUEUE] Job created:", {
          hasName: !!job.name,
          hasText: !!job.text,
          hasImage: !!job.image,
          imageName: job.image?.name
        });
        console.log("[QUEUE] Adding job to queue. Current queue length:", queue.length);
        queue.push(job);
        console.log("[QUEUE] ✓ Job added! Queue length now:", queue.length);
        console.log("[QUEUE] ===== FORM SUBMISSION COMPLETE =====");
        return new Response("queued", {
          headers: { 
            ...corsHeaders,
            "ngrok-skip-browser-warning": "true" 
          }
        });
      } catch (err: any) {
        console.error("[QUEUE] ✗ Error processing form data:", err);
        console.error("[QUEUE] Error stack:", err?.stack);
        return new Response(`error processing form: ${err?.message || err}`, { 
          status: 500,
          headers: { 
            ...corsHeaders,
            "ngrok-skip-browser-warning": "true" 
          }
        });
      }
    }
    
    // Handle assets (images)
    if (url.pathname.startsWith("/assets/")) {
      const assetPath = join(process.cwd(), url.pathname);
      if (existsSync(assetPath)) {
        try {
          const file = readFileSync(assetPath);
          const ext = extname(assetPath).toLowerCase();
          const contentType = ext === ".png" ? "image/png" : 
                             ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
                             ext === ".gif" ? "image/gif" : "application/octet-stream";
          return new Response(file, {
            headers: {
              "Content-Type": contentType,
              ...corsHeaders
            }
          });
        } catch (err: any) {
          console.error("[HTTP] Error serving asset:", err?.message || err);
          return new Response("Asset not found", { status: 404, headers: corsHeaders });
        }
      }
      return new Response("Asset not found", { status: 404, headers: corsHeaders });
    }
    
    // Handle GET requests (show form)
    if (url.pathname === "/" || url.pathname === "/chat") {
      return new Response(`
<!DOCTYPE html>
<html lang="en-US" data-theme="dark" style="color-scheme: dark;">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="ngrok-skip-browser-warning" content="true">
  <title>Send to Printer</title>
  <link rel="icon" type="image/png" href="/assets/dot.png">
  <link rel="shortcut icon" type="image/png" href="/assets/dot.png">
  <link rel="apple-touch-icon" href="/assets/dot.png">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    :root {
      --theme-bg: #14120b;
      --theme-text: #E4E4E4;
      --theme-card: #1a1810;
      --theme-border: hsl(0, 0%, 20%);
      --theme-border-hover: hsl(0, 0%, 25%);
      --theme-input-bg: #1a1810;
      --theme-button-bg: #E4E4E4;
      --theme-button-text: #14120b;
      --theme-button-hover: #f5f5f5;
      --theme-text-sec: rgba(228, 228, 228, 0.7);
    }
    
    html, body {
      margin: 0;
      padding: 0;
      overflow-x: hidden;
      height: 100%;
    }
    
    body {
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--theme-bg);
      color: var(--theme-text);
      height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      box-sizing: border-box;
      overflow-y: auto;
    }
    
    .container {
      width: 100%;
      max-width: 600px;
      box-sizing: border-box;
      padding: 0.5rem;
    }
    
    .card {
      background: var(--theme-card);
      border: 1px solid var(--theme-border);
      border-radius: 10px;
      padding: 1rem;
      box-shadow: 0 28px 70px rgba(0, 0, 0, 0.14), 0 14px 32px rgba(0, 0, 0, 0.1);
      box-sizing: border-box;
      width: 100%;
    }
    
    h1 {
      font-size: 3.5rem;
      font-weight: 600;
      text-align: center;
      margin-bottom: 1.5rem;
      margin-top: -2rem;
      color: var(--theme-text);
      letter-spacing: -0.02em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    
    h2 {
      font-size: 1.125rem;
      font-weight: 600;
      text-align: center;
      margin-bottom: 0.75rem;
      margin-top: 0;
      color: var(--theme-text);
    }
    
    .form-group {
      margin-bottom: 0.625rem;
    }
    
    label {
      display: block;
      font-size: 0.875rem;
      color: var(--theme-text-sec);
      margin-bottom: 0.5rem;
      font-weight: 500;
    }
    
    input[type="text"],
    textarea {
      width: 100%;
      padding: 0.75rem;
      font-size: 0.9375rem;
      background: var(--theme-input-bg);
      border: 1px solid var(--theme-border);
      border-radius: 6px;
      color: var(--theme-text);
      font-family: inherit;
      transition: border-color 0.2s, background-color 0.2s;
      box-sizing: border-box;
    }
    
    input[type="text"]:focus,
    textarea:focus {
      outline: none;
      border-color: var(--theme-border-hover);
      background: #1f1d15;
    }
    
    input[type="text"]::placeholder,
    textarea::placeholder {
      color: var(--theme-text-sec);
    }
    
    textarea {
      resize: vertical;
      min-height: 80px;
    }
    
    input[type="file"] {
      width: 100%;
      padding: 0.75rem;
      font-size: 0.875rem;
      background: var(--theme-input-bg);
      border: 1px solid var(--theme-border);
      border-radius: 6px;
      color: var(--theme-text);
      cursor: pointer;
      transition: border-color 0.2s;
      box-sizing: border-box;
    }
    
    input[type="file"]:hover {
      border-color: var(--theme-border-hover);
    }
    
    input[type="file"]::file-selector-button {
      padding: 0.5rem 1rem;
      margin-right: 0.75rem;
      background: var(--theme-button-bg);
      color: var(--theme-button-text);
      border: none;
      border-radius: 4px;
      font-weight: 500;
      cursor: pointer;
      transition: background-color 0.2s;
    }
    
    input[type="file"]::file-selector-button:hover {
      background: var(--theme-button-hover);
    }
    
    button[type="submit"] {
      width: 100%;
      padding: 0.875rem 1.5rem;
      font-size: 0.9375rem;
      font-weight: 500;
      background: var(--theme-button-bg);
      color: var(--theme-button-text);
      border: none;
      border-radius: 6px;
      cursor: pointer;
      transition: background-color 0.2s, transform 0.1s;
      margin-top: 0.25rem;
      box-sizing: border-box;
    }
    
    button[type="submit"]:hover {
      background: var(--theme-button-hover);
    }
    
    button[type="submit"]:active {
      transform: scale(0.98);
    }
    
    .helper-text {
      font-size: 0.75rem;
      color: var(--theme-text-sec);
      margin-top: 0.25rem;
    }
    
    /* Postcards behind the main card */
    .postcards-container {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 100%;
      max-width: 800px;
      height: 100vh;
      pointer-events: none;
      z-index: 1;
      display: flex;
      gap: 3rem;
      justify-content: center;
      align-items: center;
      flex-wrap: wrap;
    }
    
    .postcard {
      width: auto;
      height: auto;
      max-width: 200px;
      max-height: 600px;
      background: var(--theme-card);
      border: 1px solid var(--theme-border);
      border-radius: 8px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
      overflow: hidden;
      position: relative;
      transform-style: preserve-3d;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .postcard:nth-child(1) {
      transform: rotate(-25deg) translateX(-80px) translateY(-30px);
    }
    
    .postcard:nth-child(2) {
      transform: rotate(5deg) translateY(-20px);
      z-index: 1;
    }
    
    .postcard:nth-child(3) {
      transform: rotate(25deg) translateX(80px) translateY(-30px);
    }
    
    .postcard img {
      width: auto;
      height: auto;
      max-width: 100%;
      max-height: 600px;
      display: block;
      object-fit: contain;
    }
    
    .postcard::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.1) 100%);
      pointer-events: none;
    }
    
    .container {
      position: relative;
      z-index: 20;
    }
    
    /* Mobile: stack postcards vertically */
    @media (max-width: 768px) {
      h1 {
        font-size: 2rem !important;
        margin-top: -1rem !important;
        padding: 0 1rem;
      }
      
      .container {
        max-width: 100% !important;
        padding: 0.5rem 1rem;
      }
      
      .card {
        padding: 1rem;
      }
      
      .postcards-container {
        display: none;
      }
      
      .postcard {
        width: auto;
        max-width: 200px;
        max-height: 400px;
        transform: none !important;
        margin-bottom: 1.5rem;
      }
      
      .postcard img {
        max-height: 400px;
      }
      
      body {
        flex-direction: column;
        padding-bottom: 2rem;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1 style="text-align: center; font-size: 3.5rem; font-weight: 600; color: var(--theme-text); margin-bottom: 1.5rem; margin-top: -2rem; letter-spacing: -0.02em; text-transform: uppercase; white-space: nowrap;">CURSOR FOR PRINTING</h1>
    <div class="card">
      <h2 style="font-size: 1.125rem; font-weight: 600; text-align: center; margin-bottom: 0.75rem; margin-top: 0; color: var(--theme-text);">Send to Printer 🧾</h2>
      <p style="text-align: center; font-size: 0.875rem; color: var(--theme-text-sec); margin-bottom: 1rem;">Find Ameen at the printer to the right of the projector screen!</p>
      <form method="POST" enctype="multipart/form-data">
        <div class="form-group">
          <label for="name">Your name</label>
          <input type="text" id="name" name="name" placeholder="Optional">
        </div>
        <div class="form-group">
          <label for="text">Message</label>
          <textarea id="text" name="text" placeholder="What are you building?"></textarea>
        </div>
        <div class="form-group">
          <label for="image">Photo</label>
          <input type="file" id="image" name="image" accept="image/*">
          <div class="helper-text">Upload a photo from your phone</div>
        </div>
        <button type="submit">PRINT IT</button>
      </form>
    </div>
  </div>
  <div class="postcards-container">
    <div class="postcard">
      <img src="/assets/3.jpeg" alt="Example print 3">
    </div>
    <div class="postcard">
      <img src="/assets/2.jpeg" alt="Example print 2">
    </div>
    <div class="postcard">
      <img src="/assets/1.jpeg" alt="Example print 1">
    </div>
  </div>
  <script>
    const API_URL = window.location.hostname.includes('vercel.app') 
      ? 'https://tabatha-atrial-thresa.ngrok-free.dev'
      : '';
    
    document.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      if (!fd.get('text') && !fd.get('image')) {
        alert("Add text or photo!");
        return;
      }
      const button = e.target.querySelector('button[type="submit"]');
      const originalText = button.textContent;
      button.textContent = "Printing...";
      button.disabled = true;
      try {
        const url = API_URL ? API_URL + '/chat' : '/chat';
        console.log("[FORM] Submitting to:", url);
        console.log("[FORM] FormData entries:", Array.from(fd.entries()).map(function(entry) {
          var k = entry[0], v = entry[1];
          return [k, v instanceof File ? 'File: ' + v.name + ' (' + v.size + ' bytes)' : v];
        }));
        
        // Use XMLHttpRequest instead of fetch - it handles CORS better with ngrok
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        
        xhr.onload = function() {
          console.log("[FORM] XHR Response status:", xhr.status);
          console.log("[FORM] XHR Response:", xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) {
            button.textContent = "Queued! 🧾";
            setTimeout(() => {
              button.textContent = originalText;
              button.disabled = false;
            }, 2000);
            e.target.reset();
          } else {
            alert('Error: ' + xhr.status + ' - ' + xhr.responseText);
            button.textContent = "Error - Try again";
            button.disabled = false;
            setTimeout(function() {
              button.textContent = originalText;
            }, 2000);
          }
        };
        
        xhr.onerror = function() {
          console.error("[FORM] XHR Error - network failure");
          alert('Network error - failed to connect to server');
          button.textContent = "Error - Try again";
          button.disabled = false;
          setTimeout(function() {
            button.textContent = originalText;
          }, 2000);
        };
        
        xhr.send(fd);
      } catch (err) {
        console.error("[FORM] Submit error:", err);
        alert('Error: ' + (err.message || 'Failed to submit. Check console for details.'));
        button.textContent = "Error - Try again";
        button.disabled = false;
        setTimeout(() => {
          button.textContent = originalText;
        }, 2000);
      }
    };
  </script>
</body>
</html>
      `, { headers: { 
        "Content-Type": "text/html",
        ...corsHeaders
      } });
    }

    console.log("[HTTP] No matching route, returning 'ok'");
    return new Response("ok", {
      headers: { 
        ...corsHeaders,
        "ngrok-skip-browser-warning": "true" 
      }
    });
  },
});

console.log("OPEN THIS ON ANY PHONE → http://YOUR-MAC-LOCAL-IP:9999");
console.log("Find your IP: ifconfig en0 | grep inet → usually 192.168.x.x");
