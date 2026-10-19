// Generates launcher/pixelqg.ico (+ pixelqg-preview.png) from a 16x16 pixel map of the PixelQG robot
// (the screen-headed office bot of the site: same pixels and colours as the favicon).
// Zero dependencies: hand-written PNG and ICO encoders (zlib is a Node built-in).
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// '.' transparent, a antenna, g stalk, k ink outline, c casing, h highlight, s screen, e eye, d body, l chest light
const MAP = [
  '.......aa.......',
  '........g.......',
  '....kkkkkkkk....',
  '...kchhccccck...',
  '...kcssssssck...',
  '...kcsessesck...',
  '...kcsessesck...',
  '...kcssssssck...',
  '...kcccccccck...',
  '....kkkkkkkk....',
  '.....kddddk.....',
  '....kddllddk....',
  '....kddddddk....',
  '.....kk..kk.....',
  '.....kk..kk.....',
  '................',
];

const COLORS = {
  a: [0xff, 0xc8, 0x4a, 255],
  g: [0x87, 0x90, 0xb0, 255],
  k: [0x0a, 0x0b, 0x16, 255],
  c: [0x4f, 0xe3, 0xd3, 255],
  h: [0x9e, 0xf0, 0xe7, 255],
  s: [0x14, 0x1a, 0x33, 255],
  e: [0xa6, 0xff, 0xf2, 255],
  d: [0x36, 0x9a, 0x8f, 255],
  l: [0xca, 0xf7, 0xf2, 255],
  '.': [0, 0, 0, 0],
};

for (const row of MAP) if (row.length !== 16) throw new Error('bad row: ' + row);

/** RGBA buffer (top-down) of the map scaled by an integer factor. */
function render(size) {
  const k = size / 16;
  if (!Number.isInteger(k)) throw new Error('size must be a multiple of 16');
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = COLORS[MAP[Math.floor(y / k)][Math.floor(x / k)]];
      const i = (y * size + x) * 4;
      buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = c[3];
    }
  }
  return buf;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  const rgba = render(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Classic 32-bit DIB icon image (BITMAPINFOHEADER + bottom-up BGRA + empty AND mask). */
function dib(size) {
  const rgba = render(size);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND masks
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(size * size * 4, 20);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      const s = src + x * 4, d = (y * size + x) * 4;
      pixels[d] = rgba[s + 2]; pixels[d + 1] = rgba[s + 1]; pixels[d + 2] = rgba[s]; pixels[d + 3] = rgba[s + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)]);
}

function ico(sizes) {
  const images = sizes.map((s) => (s >= 128 ? png(s) : dib(s)));
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  const dir = Buffer.alloc(16 * sizes.length);
  let offset = 6 + dir.length;
  sizes.forEach((s, i) => {
    const e = i * 16;
    dir[e] = s >= 256 ? 0 : s; dir[e + 1] = s >= 256 ? 0 : s;
    dir[e + 2] = 0; dir[e + 3] = 0;
    dir.writeUInt16LE(1, e + 4); dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(images[i].length, e + 8); dir.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([head, dir, ...images]);
}

const outDir = __dirname;
fs.writeFileSync(path.join(outDir, 'pixelqg.ico'), ico([16, 32, 48, 64, 128, 256]));
fs.writeFileSync(path.join(outDir, 'pixelqg-preview.png'), png(256));
console.log('Icône écrite : ' + path.join(outDir, 'pixelqg.ico'));
