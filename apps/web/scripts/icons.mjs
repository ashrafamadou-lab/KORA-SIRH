/**
 * Générateur d'icônes KORA — PNG encodé À LA MAIN (zéro dépendance, node:zlib).
 * Identité provisoire : tuile dégradé bleu→violet, monogramme « K » géométrique.
 * Les variantes maskable gardent une marge de sécurité de 20 %.
 */
import { deflateSync } from 'node:zlib';

// ---------- encodeur PNG minimal (truecolor 8 bits, non entrelacé) ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // profondeur
  ihdr[9] = 6;   // couleur RGBA
  // lignes préfixées du filtre 0
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- dessin ----------

function lerp(a, b, t) { return a + (b - a) * t; }

/** Tuile KORA : fond dégradé arrondi + « K » clair, marge selon `pad` (0..0.5). */
export function drawKoraIcon(size, { pad = 0.08, radiusRatio = 0.22 } = {}) {
  const img = Buffer.alloc(size * size * 4);
  const margin = Math.round(size * pad);
  const inner = size - margin * 2;
  const radius = inner * radiusRatio;
  const from = { r: 0x5a, g: 0xa9, b: 0xff };  // bleu KORA
  const to = { r: 0x7f, g: 0x7b, b: 0xff };    // violet doux

  const inRoundedRect = (x, y) => {
    const lx = x - margin;
    const ly = y - margin;
    if (lx < 0 || ly < 0 || lx >= inner || ly >= inner) return false;
    const cx = Math.max(radius - lx, 0, lx - (inner - radius));
    const cy = Math.max(radius - ly, 0, ly - (inner - radius));
    return cx * cx + cy * cy <= radius * radius;
  };

  // Monogramme K : barre verticale + deux diagonales, tracé en épaisseur relative.
  const stroke = inner * 0.115;
  const kLeft = margin + inner * 0.30;
  const kTop = margin + inner * 0.24;
  const kBottom = margin + inner * 0.76;
  const kRight = margin + inner * 0.72;
  const midY = (kTop + kBottom) / 2;
  const near = (px, py, ax, ay, bx, by) => {
    const abx = bx - ax; const aby = by - ay;
    const len2 = abx * abx + aby * aby;
    const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / len2));
    const dx = px - (ax + abx * t); const dy = py - (ay + aby * t);
    return dx * dx + dy * dy <= (stroke / 2) * (stroke / 2);
  };
  const inK = (x, y) =>
    near(x, y, kLeft, kTop, kLeft, kBottom) ||
    near(x, y, kLeft, midY, kRight, kTop) ||
    near(x, y, kLeft + inner * 0.06, midY + inner * 0.02, kRight, kBottom);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRoundedRect(x, y)) {
        img[i + 3] = 0; // transparent hors tuile
        continue;
      }
      const t = (x + y) / (2 * size);
      let r = Math.round(lerp(from.r, to.r, t));
      let g = Math.round(lerp(from.g, to.g, t));
      let b = Math.round(lerp(from.b, to.b, t));
      if (inK(x, y)) { r = 0xf4; g = 0xf8; b = 0xff; }
      img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = 255;
    }
  }
  return encodePng(size, size, img);
}
