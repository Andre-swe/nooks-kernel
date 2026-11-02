// Brick colour palette. Codes are LDraw colour codes; RGB values approximate
// LDConfig.ldr. Only solid colours that are widely available as basic bricks
// and plates are included, so a generated parts list is actually buildable.

export const PALETTE = [
  { code: 0, name: 'Black', hex: '#1b2a34' },
  { code: 1, name: 'Blue', hex: '#0055bf' },
  { code: 2, name: 'Green', hex: '#237841' },
  { code: 4, name: 'Red', hex: '#c91a09' },
  { code: 14, name: 'Yellow', hex: '#f2cd37' },
  { code: 15, name: 'White', hex: '#f4f4f4' },
  { code: 19, name: 'Tan', hex: '#e4cd9e' },
  { code: 25, name: 'Orange', hex: '#fe8a18' },
  { code: 484, name: 'Dark orange', hex: '#a95500' },
  { code: 3, name: 'Dark turquoise', hex: '#008f9b' },
  { code: 27, name: 'Lime', hex: '#bbe90b' },
  { code: 28, name: 'Dark tan', hex: '#958a73' },
  { code: 70, name: 'Reddish brown', hex: '#582a12' },
  { code: 71, name: 'Light bluish grey', hex: '#a0a5a9' },
  { code: 72, name: 'Dark bluish grey', hex: '#6c6e68' },
  { code: 73, name: 'Medium blue', hex: '#5a93db' },
  { code: 78, name: 'Light nougat', hex: '#f6d7b3' },
  { code: 84, name: 'Medium nougat', hex: '#aa7d55' },
  { code: 85, name: 'Dark purple', hex: '#3f3691' },
  { code: 92, name: 'Nougat', hex: '#d09168' },
  { code: 191, name: 'Bright light orange', hex: '#f8bb3d' },
  { code: 212, name: 'Bright light blue', hex: '#9fc3e9' },
  { code: 226, name: 'Bright light yellow', hex: '#fff03a' },
  { code: 272, name: 'Dark blue', hex: '#0a3463' },
  { code: 288, name: 'Dark green', hex: '#184632' },
  { code: 308, name: 'Dark brown', hex: '#352100' },
  { code: 320, name: 'Dark red', hex: '#720e0f' },
  { code: 321, name: 'Dark azure', hex: '#078bc9' },
  { code: 322, name: 'Medium azure', hex: '#36aebf' },
  { code: 326, name: 'Yellowish green', hex: '#dfeea5' },
  { code: 330, name: 'Olive green', hex: '#9b9a5a' },
  { code: 29, name: 'Bright pink', hex: '#e4adc8' },
  { code: 5, name: 'Dark pink', hex: '#c870a0' },
  { code: 30, name: 'Medium lavender', hex: '#ac78ba' },
  // Transparent colours, used only for glass (see TRANS_CODES).
  { code: 47, name: 'Trans-clear', hex: '#e6eef2', trans: true },
  { code: 40, name: 'Trans-black', hex: '#635f52', trans: true },
  { code: 43, name: 'Trans-light blue', hex: '#aee9ef', trans: true },
  { code: 41, name: 'Trans-medium blue', hex: '#559ab7', trans: true },
  { code: 36, name: 'Trans-red', hex: '#c91a09', trans: true },
  { code: 46, name: 'Trans-yellow', hex: '#f5cd2f', trans: true },
];
export const TRANS_CODES = new Set(PALETTE.filter((c) => c.trans).map((c) => c.code));
export const SOLID_CODES = new Set(PALETTE.filter((c) => !c.trans).map((c) => c.code));

export const BY_CODE = new Map(PALETTE.map((c) => [c.code, c]));

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// sRGB (0-255) to CIE L*a*b* (D65). Perceptual distance is what makes a
// skin tone land on nougat rather than orange.
export function rgbToLab([r, g, b]) {
  const lin = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const LABS = PALETTE.map((c) => ({ code: c.code, lab: rgbToLab(hexToRgb(c.hex)) }));

export function nearestColor(rgb, allowed = SOLID_CODES) {
  const lab = rgbToLab(rgb);
  let best = null, bestD = Infinity;
  for (const c of LABS) {
    if (allowed && !allowed.has(c.code)) continue;
    const d = (lab[0] - c.lab[0]) ** 2 + (lab[1] - c.lab[1]) ** 2 + (lab[2] - c.lab[2]) ** 2;
    if (d < bestD) { bestD = d; best = c.code; }
  }
  return best;
}

// Pick at most `max` palette colours that best cover a set of RGB samples
// (weighted by frequency), so a model does not need 30 colours for one shade.
export function choosePalette(samples, max) {
  const counts = new Map();
  for (const rgb of samples) {
    const code = nearestColor(rgb);
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return new Set(ranked.slice(0, Math.max(1, max)).map(([code]) => code));
}
