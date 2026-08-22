'use strict';

/**
 * Generates build/icon.ico (a single 256x256 PNG-compressed icon) with no
 * image libraries, so `npm run dist` works from a clean checkout.
 *
 * The mark is three ascending bars in the app's own score colours.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 256;
const SAMPLES = 4; // 4x4 supersampling for smooth edges

/* ---------------- raster helpers ---------------- */

const pixels = new Float64Array(SIZE * SIZE * 4); // straight RGBA, 0..1

function insideRoundRect(px, py, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  const cx = Math.min(Math.max(px, x + radius), x + w - radius);
  const cy = Math.min(Math.max(py, y + radius), y + h - radius);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function fillRoundRect(x, y, w, h, r, [cr, cg, cb], alpha = 1) {
  const minX = Math.max(0, Math.floor(x));
  const maxX = Math.min(SIZE - 1, Math.ceil(x + w));
  const minY = Math.max(0, Math.floor(y));
  const maxY = Math.min(SIZE - 1, Math.ceil(y + h));
  const step = 1 / SAMPLES;

  for (let py = minY; py <= maxY; py += 1) {
    for (let px = minX; px <= maxX; px += 1) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const sampleX = px + (sx + 0.5) * step;
          const sampleY = py + (sy + 0.5) * step;
          if (insideRoundRect(sampleX, sampleY, x, y, w, h, r)) hits += 1;
        }
      }
      if (hits === 0) continue;

      const a = (hits / (SAMPLES * SAMPLES)) * alpha;
      const i = (py * SIZE + px) * 4;
      pixels[i] = cr / 255 * a + pixels[i] * (1 - a);
      pixels[i + 1] = cg / 255 * a + pixels[i + 1] * (1 - a);
      pixels[i + 2] = cb / 255 * a + pixels[i + 2] * (1 - a);
      pixels[i + 3] = a + pixels[i + 3] * (1 - a);
    }
  }
}

function hex(value) {
  const n = parseInt(value.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* ---------------- PNG encoder ---------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // One filter byte (0 = none) per scanline, then straight RGBA bytes.
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
  let offset = 0;
  for (let y = 0; y < SIZE; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < SIZE; x += 1) {
      const i = (y * SIZE + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        raw[offset] = Math.round(Math.min(1, Math.max(0, pixels[i + c])) * 255);
        offset += 1;
      }
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- ICO container ---------------- */

function encodeIco(pngBuffer) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count

  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 256 is encoded as 0
  entry[1] = 0; // height 256 is encoded as 0
  entry[2] = 0; // palette size
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);

  return Buffer.concat([header, entry, pngBuffer]);
}

/* ---------------- draw ---------------- */

fillRoundRect(0, 0, SIZE, SIZE, 58, hex('#171A21'));
fillRoundRect(3, 3, SIZE - 6, SIZE - 6, 55, hex('#1F242E'), 0.55);

const BASELINE = 206;
const BAR_WIDTH = 44;
const GAP = 22;
const START_X = (SIZE - (BAR_WIDTH * 3 + GAP * 2)) / 2;
const BARS = [
  { height: 68, color: '#EE7420' },
  { height: 108, color: '#E4C10A' },
  { height: 150, color: '#2FB457' },
];

BARS.forEach((bar, index) => {
  const x = START_X + index * (BAR_WIDTH + GAP);
  fillRoundRect(x, BASELINE - bar.height, BAR_WIDTH, bar.height, 15, hex(bar.color));
});

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const png = encodePng();
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeIco(png));

console.log('Wrote build/icon.ico and build/icon.png (256x256)');
