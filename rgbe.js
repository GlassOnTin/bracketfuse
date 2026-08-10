// Radiance .hdr writer: flat RGBE scanlines, no RLE. Readers detect run-length
// encoding per scanline from a 2,2,hi,lo marker; with no marker they read raw,
// so uncompressed output is valid and the encoder stays a dozen lines.
// Kept separate from app.js so it can be tested outside a browser.

export function encodeHDR(rgbFloats, w, h) {
  const header = new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`);
  const body = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const r = rgbFloats[p * 3], g = rgbFloats[p * 3 + 1], b = rgbFloats[p * 3 + 2];
    const v = Math.max(r, g, b), o = p * 4;
    if (!(v > 1e-32)) continue; // 0,0,0,0 is the encoding for black
    const e = Math.ceil(Math.log2(v));
    const k = 256 / Math.pow(2, e);
    body[o] = Math.min(255, r * k);
    body[o + 1] = Math.min(255, g * k);
    body[o + 2] = Math.min(255, b * k);
    body[o + 3] = e + 128;
  }
  const out = new Uint8Array(header.length + body.length);
  out.set(header);
  out.set(body, header.length);
  return out;
}
