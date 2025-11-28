import { execSync } from "child_process";
import { serve } from "bun";
import { PNG } from "pngjs";
import sharp from "sharp";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

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
    
    // Resize logic:
    // - Portrait: ALWAYS resize to fill width (384px) - FORCE IT BIGGER!
    // - Landscape: Resize to fit width (scale down if too wide, scale up if needed)
    if (isPortrait) {
      // Portrait: FORCE to printer width, maintain aspect ratio
      console.log(`[IMAGE] Portrait image: FORCING resize to ${printerWidth}px width (making it BIGGER!)`);
      sharpInstance = sharpInstance.resize(printerWidth, null, {
        withoutEnlargement: false, // CRITICAL: Allow scaling UP for small images
        fit: 'fill' // Fill the width exactly
      });
    } else {
      // Landscape: Resize to fit width
      if ((rotatedMetadata.width || 0) > printerWidth) {
        console.log(`[IMAGE] Landscape too wide: scaling down to ${printerWidth}px`);
        sharpInstance = sharpInstance.resize(printerWidth, null, {
          withoutEnlargement: false,
          fit: 'inside'
        });
      } else if ((rotatedMetadata.width || 0) >= printerWidth * 0.7) {
        console.log(`[IMAGE] Landscape close to width: scaling up to ${printerWidth}px`);
        sharpInstance = sharpInstance.resize(printerWidth, null, {
          withoutEnlargement: false,
          fit: 'inside'
        });
      } else {
        console.log(`[IMAGE] Landscape too small: keeping original size`);
      }
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
  
  // Convert to bitmap
  const { width, height, data } = png;
  const bytesPerRow = Math.ceil(width / 8);
  const bitmap = Buffer.alloc(bytesPerRow * height);
  
  // Convert to 1bpp (MSB first)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const alpha = data[idx + 3];
      
      if (alpha < 128) continue; // Transparent = white
      
      // Grayscale conversion
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      const isBlack = luminance < 128;
      
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
    
    // Order: Logo → Text → Image (with minimal spacing)
    
    // 1. Add logo first (if logo exists and image is present)
    if (logoBuffer && job.image) {
      try {
        console.log("[PRINT] Adding logo...");
        parts.push(Buffer.from("\n")); // Minimal spacing before logo
        
        // Center the logo
        parts.push(Buffer.from([0x1b, 0x61, 0x01])); // ESC a 1 (center)
        
        const logoData = await processImage(logoBuffer);
        console.log("[PRINT] Logo processed, ESC/POS size:", logoData.length, "bytes");
        parts.push(logoData);
        
        // Reset alignment to left after logo
        parts.push(Buffer.from([0x1b, 0x61, 0x00])); // ESC a 0 (left)
        parts.push(Buffer.from("\n")); // Minimal spacing after logo
      } catch (logoErr: any) {
        console.error("[PRINT] Logo processing failed:", logoErr?.message || logoErr);
        // Continue even if logo fails
      }
    }
    
    // 2. Add text (between logo and image) - styled for café receipts
    if (job.name || job.text) {
      // Name: Bold, larger, centered
      if (job.name) {
        parts.push(Buffer.from([0x1b, 0x61, 0x01])); // Center align
        parts.push(Buffer.from([0x1b, 0x45, 0x01])); // Bold ON
        parts.push(Buffer.from([0x1d, 0x21, 0x11])); // Double height + width (GS !)
        parts.push(Buffer.from(job.name));
        parts.push(Buffer.from([0x1d, 0x21, 0x00])); // Normal size
        parts.push(Buffer.from([0x1b, 0x45, 0x00])); // Bold OFF
        parts.push(Buffer.from([0x1b, 0x61, 0x00])); // Left align
        parts.push(Buffer.from("\n"));
      }
      
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
        parts.push(Buffer.from("\n")); // Minimal spacing after image
      } catch (imgErr: any) {
        console.error("[PRINT] Image processing failed:", imgErr?.message || imgErr);
        console.error("[PRINT] Error stack:", imgErr?.stack);
        parts.push(Buffer.from("\n[Image processing error]\n"));
      }
    }
    
    // Add newlines at end
    parts.push(Buffer.from("\n\n\n\n\n\n"));
    
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

print({ text: "🧾 PRINTER READY – café mode activated 🧾" });

serve({
  port: 9999,
  async fetch(req) {
    const url = new URL(req.url);
    console.log("[HTTP] ===== REQUEST =====");
    console.log("[HTTP] Method:", req.method);
    console.log("[HTTP] Path:", url.pathname);
    console.log("[HTTP] URL:", req.url);
    
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
        return new Response("queued");
      } catch (err: any) {
        console.error("[QUEUE] ✗ Error processing form data:", err);
        console.error("[QUEUE] Error stack:", err?.stack);
        return new Response(`error processing form: ${err?.message || err}`, { status: 500 });
      }
    }
    
    // Handle GET requests (show form)
    if (url.pathname === "/" || url.pathname === "/chat") {
      return new Response(`
<!DOCTYPE html>
<html style="font-family:system-ui;background:#000;color:#fff;height:100vh;margin:0;display:grid;place-items:center">
  <form method="POST" enctype="multipart/form-data" style="background:#111;padding:2rem;border-radius:1rem;width:90%;max-width:420px">
    <h1 style="text-align:center">Send to Printer 🧾</h1>
    <input name="name" placeholder="Your name (optional)" style="width:100%;padding:1rem;margin:0.5rem 0;font-size:1.2rem;border-radius:0.5rem;border:none">
    <textarea name="text" placeholder="Message" rows="4" style="width:100%;padding:1rem;margin:0.5rem 0;font-size:1.2rem;border-radius:0.5rem;border:none"></textarea>
    <input type="file" name="image" accept="image/*" style="width:100%;padding:1rem;margin:0.5rem 0">
    <button type="submit" style="width:100%;padding:1rem;font-size:1.5rem;background:#0f0;color:#000;border:none;border-radius:0.5rem">PRINT IT</button>
  </form>
  <script>
    document.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      if (!fd.get('text') && !fd.get('image')) {
        alert("Add text or photo!");
        return;
      }
      await fetch("/chat", {method:"POST",body:fd});
      alert("Printing in a few seconds! 🧾");
      e.target.reset();
    };
  </script>
</html>
      `, { headers: { "Content-Type": "text/html" } });
    }

    console.log("[HTTP] No matching route, returning 'ok'");
    return new Response("ok");
  },
});

console.log("OPEN THIS ON ANY PHONE → http://YOUR-MAC-LOCAL-IP:9999");
console.log("Find your IP: ifconfig en0 | grep inet → usually 192.168.x.x");
