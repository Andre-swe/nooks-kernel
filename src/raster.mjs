// Pictures of a model's real parts, for agents to look at what they built (the MCP `view` tool), from any
// azimuth and elevation, as BrickAgent's viewer frames them. No GPU and no three: the parts' LDraw geometry
// (ldraw/<id>.mpd and ldraw/primitives.mpd, CC BY 4.0) is walked into triangles and drawn with a depth buffer,
// soft key-and-fill lighting and a dark outline round every part, so an agent can tell the pieces apart.
// Pure: the caller reads the geometry files and passes their text; the same input gives the same pixels.
//
// Geometry is in LDraw units and axes (-y up); the picture is drawn in this app's axes (y up), as the viewer shows it.
import { BY_CODE } from './palette.mjs';
import { apply } from './pose.mjs';

// The files of an MPD by lower-case name, each a list of rows (fields), as ldraw.mjs reads them.
export function readFiles(text) {
  // (a plain .ldr has no 0 FILE lines: what comes before the first one is a main file named '')
  const files = new Map([['', []]]);
  let current = '', first = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (line.startsWith('0 FILE ')) { current = line.slice(7).trim().toLowerCase().replace(/\\/g, '/'); files.set(current, []); first ??= current; continue; }
    if (line.startsWith('0 NOFILE')) { current = null; continue; }
    if (current != null && line && !line.startsWith('0')) files.get(current).push(line.split(/\s+/));
  }
  if (files.get('').length) first = '';
  else files.delete('');
  return { files, first };
}

// A part's triangles: { tris: Float32Array (9 numbers a triangle, LDU, the part's frame), codes: Int32Array (each
// triangle's colour code, 16 for the part's own colour) }. `prims`: readFiles(primitives.mpd).files.
export function mesh(text, prims = new Map()) {
  const own = readFiles(text);
  const get = (name) => own.files.get(name) ?? prims.get(name);
  const tris = [], codes = [], missing = new Set();
  const walk = (name, M, inherit, depth) => {
    const rows = get(name);
    if (!rows || depth > 24) { missing.add(name ?? '(no main file)'); return; }
    for (const t of rows) {
      const code = Number(t[1]), colour = code === 16 ? inherit : code;
      if (t[0] === '1' && t.length >= 15) {
        const [x, y, z, a, b, c, d, e, f, g, h, i] = t.slice(2, 14).map(Number);
        const N = [M[0] * a + M[1] * d + M[2] * g, M[0] * b + M[1] * e + M[2] * h, M[0] * c + M[1] * f + M[2] * i, M[0] * x + M[1] * y + M[2] * z + M[3],
          M[4] * a + M[5] * d + M[6] * g, M[4] * b + M[5] * e + M[6] * h, M[4] * c + M[5] * f + M[6] * i, M[4] * x + M[5] * y + M[6] * z + M[7],
          M[8] * a + M[9] * d + M[10] * g, M[8] * b + M[9] * e + M[10] * h, M[8] * c + M[9] * f + M[10] * i, M[8] * x + M[9] * y + M[10] * z + M[11]];
        walk(t.slice(14).join(' ').toLowerCase().replace(/\\/g, '/'), N, colour, depth + 1);
      } else if (t[0] === '3' || t[0] === '4') {
        const n = t[0] === '3' ? 3 : 4, p = [];
        for (let k = 0; k < n; k++) {
          const x = +t[2 + k * 3], y = +t[3 + k * 3], z = +t[4 + k * 3];
          p.push([M[0] * x + M[1] * y + M[2] * z + M[3], M[4] * x + M[5] * y + M[6] * z + M[7], M[8] * x + M[9] * y + M[10] * z + M[11]]);
        }
        for (const [u, v, w] of n === 3 ? [[0, 1, 2]] : [[0, 1, 2], [0, 2, 3]]) { tris.push(...p[u], ...p[v], ...p[w]); codes.push(colour); }
      }
    }
  };
  walk(own.first, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], 16, 0);
  return { tris: Float32Array.from(tris), codes: Int32Array.from(codes), missing: [...missing] };
}

const rgbOf = (code) => {
  const hex = typeof code === 'string' && /^#[0-9a-f]{6}$/i.test(code) ? code : BY_CODE.get(code)?.hex ?? (code === 0 ? '#1b2a34' : code === 15 ? '#f4f4f4' : '#a0a5a9');
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
};
const lin = (c) => Math.pow(c, 2.2), srgb = (c) => Math.round(255 * Math.pow(Math.min(1, Math.max(0, c)), 1 / 2.2));
const norm = (v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
const KEY = norm([-3, 5, 4]);

// Draw parts: items [{ mesh, color, pose }] (pose in LDraw units and axes). → { rgb: Uint8Array, width, height, az, el }.
// az, el in degrees; left out, they are chosen as BrickAgent's viewer chooses them (a three-quarter view from the
// front, turned to an elongated model's broad side; the elevation from its proportions).
// `highlight`: item indices outlined in the highlight colour (a manual's new parts); `points`: [x, y, z] in the same
// world (the app's axes, LDU) to give back as where they land in the picture ({ points: [[0–1 across, 0–1 down]] }).
export function render(items, { width = 800, height = 600, az = null, el = null, fov = 30, background = [12, 16, 22], outline = true, supersample = 2, highlight = null, highlightColour = [49, 83, 204], points = null } = {}) {
  const W = width * supersample, H = height * supersample;
  // World vertices in the app's axes (y up), per item.
  const worldOf = ({ mesh: m, pose }) => {
    const out = new Float32Array(m.tris.length);
    for (let k = 0; k < m.tris.length; k += 3) { const v = apply(pose, [m.tris[k], m.tris[k + 1], m.tris[k + 2]]); out[k] = v[0]; out[k + 1] = -v[1]; out[k + 2] = -v[2]; }
    return out;
  };
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const item of items) { const w = worldOf(item); for (let k = 0; k < w.length; k++) { const a = k % 3; if (w[k] < lo[a]) lo[a] = w[k]; if (w[k] > hi[a]) hi[a] = w[k]; } }
  if (!(lo[0] <= hi[0])) return { rgb: new Uint8Array(width * height * 3).fill(background[0]), width, height, az: az ?? 30, el: el ?? 30 };
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((m) => [m & 1 ? hi[0] : lo[0], m & 2 ? hi[1] : lo[1], m & 4 ? hi[2] : lo[2]]);
  const centre = [0, 1, 2].map((a) => (lo[a] + hi[a]) / 2);
  if (az === null) {
    let xx = 0, xz = 0, zz = 0;
    for (const p of corners) { const x = p[0] - centre[0], z = p[2] - centre[2]; xx += x * x; xz += x * z; zz += z * z; }
    const bearing = (0.5 * Math.atan2(2 * xz, xx - zz) * 180) / Math.PI;
    const views = [-30, 30, 150, 210].map((a) => ((a - bearing + 540) % 360) - 180).sort((a, b) => Math.abs(a - 30) - Math.abs(b - 30));
    az = Math.hypot(xx - zz, 2 * xz) < (xx + zz) / 3 ? 30 : views[0];
  }
  const size = hi.map((v, a) => v - lo[a]);
  el ??= Math.min(60, Math.max(22, (Math.atan2(Math.min(size[0], size[2]), 2 * size[1]) * 180) / Math.PI));
  const ra = (az * Math.PI) / 180, re = (el * Math.PI) / 180;
  const dir = [Math.cos(re) * Math.sin(ra), Math.sin(re), Math.cos(re) * Math.cos(ra)], right = [Math.cos(ra), 0, -Math.sin(ra)];
  const up = [dir[1] * right[2] - dir[2] * right[1], dir[2] * right[0] - dir[0] * right[2], dir[0] * right[1] - dir[1] * right[0]];
  const vert = Math.tan((fov * Math.PI) / 360), horiz = vert * (width / height);
  const local = (p) => { const q = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]]; return [q[0] * right[0] + q[1] * right[1] + q[2] * right[2], q[0] * up[0] + q[1] * up[1] + q[2] * up[2], q[0] * dir[0] + q[1] * dir[1] + q[2] * dir[2]]; };
  const pts = corners.map(local);
  let reach = 1;
  for (const p of pts) reach = Math.max(reach, Math.abs(p[0]) / horiz + p[2], Math.abs(p[1]) / vert + p[2]);
  const D = 1.1 * reach;
  // Centre the silhouette as it projects (perspective: the near side looks bigger than the far).
  let sx0 = Infinity, sx1 = -Infinity, sy0 = Infinity, sy1 = -Infinity;
  for (const p of pts) { const zc = D - p[2], X = p[0] / (zc * horiz), Y = p[1] / (zc * vert); sx0 = Math.min(sx0, X); sx1 = Math.max(sx1, X); sy0 = Math.min(sy0, Y); sy1 = Math.max(sy1, Y); }
  const shiftX = (sx0 + sx1) / 2, shiftY = (sy0 + sy1) / 2;
  const depth = new Float32Array(W * H).fill(Infinity), owner = new Int32Array(W * H).fill(-1), colour = new Float32Array(W * H * 3);
  const project = (x, y, z) => {
    const q = local([x, y, z]), zc = D - q[2];
    return [((q[0] / (zc * horiz) - shiftX) * 0.5 + 0.5) * W, (0.5 - (q[1] / (zc * vert) - shiftY) * 0.5) * H, zc];
  };
  items.forEach((item, idx) => {
    const w = worldOf(item), codes = item.mesh.codes, own = item.color ?? 16;
    for (let t = 0, k = 0; k < w.length; t++, k += 9) {
      const A = project(w[k], w[k + 1], w[k + 2]), B = project(w[k + 3], w[k + 4], w[k + 5]), C = project(w[k + 6], w[k + 7], w[k + 8]);
      if (A[2] <= 0 || B[2] <= 0 || C[2] <= 0) continue;
      // Shade: the face normal, turned toward the camera (both sides drawn), lit by a key light and a soft fill.
      const e1 = [w[k + 3] - w[k], w[k + 4] - w[k + 1], w[k + 5] - w[k + 2]], e2 = [w[k + 6] - w[k], w[k + 7] - w[k + 1], w[k + 8] - w[k + 2]];
      let n = norm([e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]);
      if (n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2] < 0) n = n.map((x) => -x);
      const light = 0.42 + 0.18 * (0.5 + 0.5 * n[1]) + 0.55 * Math.max(0, n[0] * KEY[0] + n[1] * KEY[1] + n[2] * KEY[2]);
      const code = item.diagnostic || codes[t] === 16 || codes[t] === 24 ? own : codes[t], base = rgbOf(code).map(lin);
      const r = base[0] * light, g = base[1] * light, b = base[2] * light;
      const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
      const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
      const area = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
      if (Math.abs(area) < 1e-9) continue;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((B[0] - px) * (C[1] - py) - (B[1] - py) * (C[0] - px)) / area;
        const w1 = ((C[0] - px) * (A[1] - py) - (C[1] - py) * (A[0] - px)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = 1 / (w0 / A[2] + w1 / B[2] + w2 / C[2]), i = y * W + x;
        if (z >= depth[i]) continue;
        depth[i] = z; owner[i] = idx; colour[i * 3] = r; colour[i * 3 + 1] = g; colour[i * 3 + 2] = b;
      }
    }
  });
  // Outlines where one part meets another or the background, darker the nearer part.
  if (outline) {
    const edge = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x, o = owner[i];
      if (o < 0) continue;
      for (const j of [i - 1, i + 1, i - W, i + W]) if (owner[j] !== o && (owner[j] < 0 || depth[j] > depth[i] - 0.5)) { edge[i] = 1; break; }
    }
    for (let i = 0; i < W * H; i++) if (edge[i]) { colour[i * 3] *= 0.35; colour[i * 3 + 1] *= 0.35; colour[i * 3 + 2] *= 0.35; }
    if (highlight?.size) {
      const hc = highlightColour.map((c) => lin(c / 255)), r = Math.max(1, supersample);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!edge[i] || !highlight.has(owner[i])) continue;
        for (let dy = -r + 1; dy < r; dy++) for (let dx = -r + 1; dx < r; dx++) { const yy = y + dy, xx = x + dx; if (yy < 0 || xx < 0 || yy >= H || xx >= W) continue; const j = yy * W + xx; if (owner[j] < 0) continue; colour[j * 3] = hc[0]; colour[j * 3 + 1] = hc[1]; colour[j * 3 + 2] = hc[2]; }
      }
    }
  }
  const rgb = new Uint8Array(width * height * 3), bg = background;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sum = [0, 0, 0];
    for (let sy = 0; sy < supersample; sy++) for (let sx = 0; sx < supersample; sx++) {
      const i = (y * supersample + sy) * W + x * supersample + sx;
      if (owner[i] < 0) { sum[0] += lin(bg[0] / 255); sum[1] += lin(bg[1] / 255); sum[2] += lin(bg[2] / 255); }
      else { sum[0] += colour[i * 3]; sum[1] += colour[i * 3 + 1]; sum[2] += colour[i * 3 + 2]; }
    }
    const n = supersample * supersample, o = (y * width + x) * 3;
    rgb[o] = srgb(sum[0] / n); rgb[o + 1] = srgb(sum[1] / n); rgb[o + 2] = srgb(sum[2] / n);
  }
  const at = points ? points.map((q) => { const P = project(q[0], q[1], q[2]); return [+(P[0] / W).toFixed(4), +(P[1] / H).toFixed(4)]; }) : undefined;
  return { rgb, width, height, az, el, ...(at ? { points: at } : {}) };
}
