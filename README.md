# Thermal Printer Server (USB)

A simple server for printing to USB thermal printers.

## Setup

1. **Install Bun** (if not already installed):
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

2. **Install dependencies**:
   ```bash
   bun install
   ```

3. **Connect your USB thermal printer** (Epson TM-m50, TM-T20II, etc.)

4. **Run the server**:
   ```bash
   bun server.ts
   ```

5. **Access the web interface**:
   - Open `http://YOUR-MAC-LOCAL-IP:9999` on any device
   - Find your IP: `ifconfig en0 | grep inet`

## Features

- USB printer support (no network required)
- Web interface for sending messages
- Image printing support
- Queue system (prints every 8 seconds)
- ESC/POS compatible thermal printers

## USB Setup Notes

- **macOS**: Should work out of the box

## Supported Printers

Any ESC/POS compatible thermal printer, including:
- Epson TM-m50, TM-T20II, TM-m30 series
- Star Micronics printers
- Other ESC/POS thermal printers

## Usage

1. Open the web interface on any device
2. Enter your name (optional)
3. Type a message or upload an image
4. Click "PRINT IT"
5. Your message will be queued and printed in a few seconds!




