'use strict';
/**
 * 运行时生成托盘图标 —— 不依赖任何外部素材文件。
 * 一个小小的深靛蓝圆角块，中间一道琥珀斜杠，像终端光标。
 * 放在系统托盘里毫不起眼，但你自己一眼能认出来。
 */
const zlib = require('zlib');

const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(w, h, rgba) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// 圆角矩形 SDF 覆盖率（0..1）
function roundRectCoverage(px, py, w, h, r) {
  const cx = w / 2;
  const cy = h / 2;
  const qx = Math.abs(px - cx) - (w / 2 - r);
  const qy = Math.abs(py - cy) - (h / 2 - r);
  const dx = Math.max(qx, 0);
  const dy = Math.max(qy, 0);
  const d = Math.sqrt(dx * dx + dy * dy) + Math.min(Math.max(qx, qy), 0) - r;
  return Math.min(Math.max(0.5 - d, 0), 1);
}

// 线段 SDF 覆盖率
function segCoverage(px, py, ax, ay, bx, by, half) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy || 1;
  let t = (wx * vx + wy * vy) / len2;
  t = Math.min(Math.max(t, 0), 1);
  const dx = wx - vx * t;
  const dy = wy - vy * t;
  const d = Math.sqrt(dx * dx + dy * dy) - half;
  return Math.min(Math.max(0.5 - d, 0), 1);
}

function makeIconBuffer(size) {
  size = size || 32;
  const buf = Buffer.alloc(size * size * 4);
  const r = size * 0.24;
  const half = size * 0.055;
  const ax = size * 0.65;
  const ay = size * 0.2;
  const bx = size * 0.35;
  const by = size * 0.8;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const body = roundRectCoverage(px, py, size, size, r);
      const slash = segCoverage(px, py, ax, ay, bx, by, half) * body;

      // 底色 #1b2030，斜杠 #ffb454
      const bgR = 0x1b;
      const bgG = 0x20;
      const bgB = 0x30;

      const rC = Math.round(bgR + (0xff - bgR) * slash);
      const gC = Math.round(bgG + (0xb4 - bgG) * slash);
      const bC = Math.round(bgB + (0x54 - bgB) * slash);

      const i = (y * size + x) * 4;
      buf[i] = rC;
      buf[i + 1] = gC;
      buf[i + 2] = bC;
      buf[i + 3] = Math.round(255 * Math.max(body, slash));
    }
  }
  return encodePNG(size, size, buf);
}

module.exports = { makeIconBuffer: makeIconBuffer, encodePNG: encodePNG };
