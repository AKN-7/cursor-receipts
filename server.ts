import { createPrinter, type MessageContent } from "./lib/index";

let queue: MessageContent[] = [];

const printer = createPrinter({ useUSB: true });

function print(content: MessageContent) {
  const preview = content.text?.slice(0, 50).replace(/\n/g, " ") || "[image]";
  console.log("PRINTED:", preview);
}

setInterval(async () => {
  if (queue.length > 0) {
    const content = queue.shift()!;
    console.log(`[🧾] Processing queue item (${queue.length} remaining)...`);
    console.log(`[🧾] Content:`, JSON.stringify({ name: content.name, text: content.text?.slice(0, 50), hasImage: !!content.image }));
    try {
      // Ensure printer is initialized
      await printer.initialize();
      console.log(`[🧾] Printer initialized, printing...`);
      const startTime = Date.now();
      await Promise.race([
        printer.printMessage(content),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Print timeout after 30 seconds")), 30000)
        )
      ]);
      const duration = Date.now() - startTime;
      console.log(`[🧾] Print completed in ${duration}ms`);
      print(content);
    } catch (err: any) {
      console.error("[🧾] Print error:", err);
      console.error("[🧾] Error details:", err?.message);
      if (err?.stack) console.error("[🧾] Stack:", err.stack);
    }
  } else {
    // Log every minute that queue is empty (for debugging)
    const now = new Date();
    if (now.getSeconds() < 2) {
      console.log(`[🧾] Queue empty, waiting for messages...`);
    }
  }
}, 8000); // one print every 8 sec = perfect pace

// Initialize printer on startup
printer.initialize().then(() => {
  printer.printMessage({
    text: "🧾 PRINTER READY – café mode activated 🧾",
  }).catch(console.error);
}).catch(console.error);

Bun.serve({
  port: 9999,
  async fetch(req) {
    console.log(`[🧾] ${req.method} ${req.url}`);
    const url = new URL(req.url);
    
    // Handle POST requests FIRST (before GET check)
    if (url.pathname === "/chat" && req.method === "POST") {
      console.log("[🧾] ✅ POST /chat detected!");
      console.log("[🧾] Content-Type:", req.headers.get("content-type"));
      console.log("[🧾] Content-Length:", req.headers.get("content-length"));
      
      try {
        console.log("[🧾] Parsing formData...");
        const fd = await req.formData();
        console.log("[🧾] ✅ FormData parsed successfully");
        
        const name = fd.get("name") as string | null;
        const text = fd.get("text") as string | null;
        const imageFile = fd.get("image") as File | null;
        
        console.log(`[🧾] Fields extracted - name: "${name || 'empty'}", text: "${text?.slice(0, 30) || 'empty'}", image: ${imageFile ? `${imageFile.size}B` : "none"}`);
        
        // Limit image size to 5MB
        if (imageFile && imageFile.size > 5 * 1024 * 1024) {
          console.error(`[🧾] Image too large: ${imageFile.size} bytes (max 5MB)`);
          return new Response("Image too large (max 5MB)", { status: 400 });
        }
        
        const content: MessageContent = {
          name: name || undefined,
          text: text || undefined,
          image: imageFile && imageFile.size > 0 ? imageFile : undefined,
        };
        
        if (!content.text && !content.image) {
          content.text = "blank print";
        }
        
        queue.push(content);
        console.log(`[🧾] ✅✅✅ QUEUED! Queue size now: ${queue.length}`);
        console.log(`[🧾] Message preview:`, content.text?.slice(0, 50) || "[image]");
        
        return new Response("queued", { status: 200 });
      } catch (err: any) {
        console.error("[🧾] ❌❌❌ ERROR processing form data:", err);
        console.error("[🧾] Error message:", err?.message);
        console.error("[🧾] Error stack:", err?.stack);
        return new Response(`error: ${err?.message}`, { status: 500 });
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

    return new Response("ok");
  },
});

console.log("OPEN THIS ON ANY PHONE → http://YOUR-MAC-LOCAL-IP:9999");
console.log("Find your IP: ifconfig en0 | grep inet → usually 192.168.x.x");

