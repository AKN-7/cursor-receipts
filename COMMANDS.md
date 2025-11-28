# Thermal Printer Server Commands

## Server Management

### Start server
```bash
cd /Users/ameenneami/Development/Work/Cursor-Community/thermal
bun server.ts > /tmp/thermal-server.log 2>&1 &
```

### Stop server
```bash
lsof -ti:9999 | xargs kill -9
```

### Check if server is running
```bash
lsof -ti:9999 || echo "Port 9999 is free"
ps aux | grep "bun server.ts" | grep -v grep
```

### View server logs
```bash
tail -f /tmp/thermal-server.log
```

## ngrok Tunnel Management

### Start ngrok
```bash
ngrok http 9999
```

### Start ngrok in background
```bash
ngrok http 9999 > /tmp/ngrok.log 2>&1 &
```

### Stop ngrok
```bash
pkill -9 ngrok
```

### Get ngrok public URL
```bash
curl -s http://localhost:4040/api/tunnels | python3 -c "import sys, json; data=json.load(sys.stdin); tunnels=data.get('tunnels', []); print(tunnels[0]['public_url'] if tunnels else 'No tunnels')"
```

### Check ngrok status
```bash
ps aux | grep ngrok | grep -v grep
```

## Quick Restart Everything

### Kill all and restart
```bash
lsof -ti:9999 | xargs kill -9 2>/dev/null
pkill -9 ngrok 2>/dev/null
cd /Users/ameenneami/Development/Work/Cursor-Community/thermal
bun server.ts > /tmp/thermal-server.log 2>&1 &
sleep 2
ngrok http 9999 > /tmp/ngrok.log 2>&1 &
sleep 5
curl -s http://localhost:4040/api/tunnels | python3 -c "import sys, json; data=json.load(sys.stdin); tunnels=data.get('tunnels', []); print(tunnels[0]['public_url'] if tunnels else 'No tunnels')"
```

## Test Server

### Test local server
```bash
curl http://localhost:9999/
```

### Test through ngrok (replace URL)
```bash
curl https://your-ngrok-url.ngrok-free.dev/
```

