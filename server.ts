import { execSync } from "child_process";
import { serve } from "bun";
import { PNG } from "pngjs";

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

async function processImage(imageData: Buffer): Promise<Buffer> {
  console.log("[IMAGE] Processing image buffer:", imageData.length, "bytes");
  
  // Decode PNG
  let png: PNG;
  try {
    png = PNG.sync.read(imageData);
    console.log("[IMAGE] PNG decoded:", png.width, "x", png.height);
  } catch (err: any) {
    console.error("[IMAGE] PNG decode failed:", err?.message || err);
    throw new Error(`Failed to decode image: ${err?.message || err}`);
  }
  
  // Resize if too wide (thermal printers are usually 384px wide)
  const maxWidth = 384;
  if (png.width > maxWidth) {
    const ratio = maxWidth / png.width;
    const newWidth = maxWidth;
    const newHeight = Math.round(png.height * ratio);
    const resized = new PNG({ width: newWidth, height: newHeight });
    // Simple nearest-neighbor resize
    for (let y = 0; y < newHeight; y++) {
      for (let x = 0; x < newWidth; x++) {
        const srcX = Math.floor(x / ratio);
        const srcY = Math.floor(y / ratio);
        const srcIdx = (srcY * png.width + srcX) * 4;
        const dstIdx = (y * newWidth + x) * 4;
        resized.data[dstIdx] = png.data[srcIdx];
        resized.data[dstIdx + 1] = png.data[srcIdx + 1];
        resized.data[dstIdx + 2] = png.data[srcIdx + 2];
        resized.data[dstIdx + 3] = png.data[srcIdx + 3];
      }
    }
    png.width = newWidth;
    png.height = newHeight;
    png.data = resized.data;
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
    
    // Add text
    let text = "";
    if (job.name) text += `${job.name}\n\n`;
    if (job.text) text += job.text;
    if (text) {
      parts.push(Buffer.from(text));
      console.log("[PRINT] Added text:", text.slice(0, 50));
    }
    
    // Add image if present
    if (job.image) {
      console.log("[PRINT] Processing image:", job.image.name, job.image.data.length, "bytes");
      try {
        parts.push(Buffer.from("\n")); // Line feed before image
        const imageData = await processImage(job.image.data);
        console.log("[PRINT] Image processed, ESC/POS size:", imageData.length, "bytes");
        parts.push(imageData);
        parts.push(Buffer.from("\n")); // Line feed after image
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
