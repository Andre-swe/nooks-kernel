// A brick model as a 3D file, for printing, rendering or another program: STL (binary, millimetres, z up, as
// slicers expect), OBJ (with vertex colours, millimetres, y up) and GLB (glTF 2.0, one material per brick colour,
// metres, y up). The geometry is each part's real shape (lib/raster.mjs reads it from the LDraw bundle), placed
// where the model's LDraw has it. Pure: the parts' meshes come in through `meshOf`; no DOM, no network.
import { readFiles } from './raster.mjs';
import { compose, apply } from './pose.mjs';
import { BY_CODE } from './palette.mjs';

export const FORMATS = { stl: 'model/stl', obj: 'model/obj', glb: 'model/gltf-binary' };
const MM = 0.4;                                 // millimetres to an LDraw unit

// The parts of a model's LDraw text (lib/export.mjs toLDraw), submodels followed: [{ mesh, color, pose }], and
// the part ids with no geometry. `meshOf(id)` → lib/raster.mjs mesh() of the part, or null.
export async function itemsFromLDraw(ldraw, meshOf) {
  const { files, first } = readFiles(ldraw);
  const items = [], missing = new Set();
  const walk = async (name, M, inherit, depth) => {
    if (depth > 16) return;
    for (const t of files.get(name) ?? []) {
      if (t[0] !== '1' || t.length < 15) continue;
      const code = Number(t[1]), colour = code === 16 ? inherit : code;
      const [x, y, z, a, b, c, d, e, f, g, h, i] = t.slice(2, 14).map(Number);
      const pose = compose(M, { r: [a, b, c, d, e, f, g, h, i], t: [x, y, z] });
      const ref = t.slice(14).join(' ').toLowerCase().replace(/\\/g, '/');
      if (files.has(ref)) { await walk(ref, pose, colour, depth + 1); continue; }
      const id = ref.replace(/^.*\//, '').replace(/\.dat$/, ''), m = await meshOf(id);
      if (m) items.push({ mesh: m, color: colour, pose }); else missing.add(id);
    }
  };
  await walk(first, { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }, 16, 0);
  return { items, missing: [...missing] };
}

const rgbOf = (code) => {
  const hex = BY_CODE.get(code)?.hex ?? '#a0a5a9';
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
};
// Every triangle in model space (LDU, -y up) with its colour code: calls `fn(a, b, c, code)`.
function eachTriangle(items, fn) {
  for (const { mesh, color, pose } of items) {
    const T = mesh.tris, C = mesh.codes;
    for (let t = 0; t < C.length; t++) {
      const code = C[t] === 16 || C[t] === 24 ? color : C[t], o = t * 9;
      fn(apply(pose, [T[o], T[o + 1], T[o + 2]]), apply(pose, [T[o + 3], T[o + 4], T[o + 5]]), apply(pose, [T[o + 6], T[o + 7], T[o + 8]]), code);
    }
  }
}
export const triangleCount = (items) => items.reduce((n, it) => n + it.mesh.codes.length, 0);
// The model standing on z = 0 (STL) or y = 0 (OBJ, GLB), centred on the other two axes.
function frame(items, up) {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  eachTriangle(items, (...p) => { for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j], p[k][j]); hi[j] = Math.max(hi[j], p[k][j]); } });
  const cx = (lo[0] + hi[0]) / 2, cz = (lo[2] + hi[2]) / 2, floor = hi[1];      // -y up: the lowest point is the largest y
  // LDraw (x, -y up, z) turned so up is +z (rotate -90° about x) or +y (180° about x), both proper rotations.
  return up === 'z' ? ([x, y, z]) => [(x - cx) * MM, (z - cz) * MM, (floor - y) * MM] : ([x, y, z]) => [(x - cx) * MM, (floor - y) * MM, -(z - cz) * MM];
}
const normal = (a, b, c) => {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(...n) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
};

export function toSTL(items, { name = 'Nooks model' } = {}) {
  const n = triangleCount(items), out = new Uint8Array(84 + n * 50), v = new DataView(out.buffer);
  out.set(new TextEncoder().encode(`${name} · Nooks · mm`.slice(0, 80)));
  v.setUint32(80, n, true);
  const at = frame(items, 'z');
  let o = 84;
  // (LDraw's -y up turned to +z up flips nothing's winding: the rotation is proper)
  eachTriangle(items, (A, B, C) => {
    const a = at(A), b = at(B), c = at(C), nm = normal(a, b, c);
    for (const p of [nm, a, b, c]) for (const x of p) { v.setFloat32(o, x, true); o += 4; }
    o += 2;
  });
  return out;
}

export function toOBJ(items, { name = 'Nooks model' } = {}) {
  const at = frame(items, 'y'), v = [], f = [];
  let k = 1;
  const fx = (x) => +x.toFixed(3);
  eachTriangle(items, (A, B, C, code) => {
    const [r, g, b] = rgbOf(code).map((x) => +(x / 255).toFixed(3));
    for (const p of [A, B, C]) v.push(`v ${at(p).map(fx).join(' ')} ${r} ${g} ${b}`);
    f.push(`f ${k} ${k + 1} ${k + 2}`); k += 3;
  });
  return `# ${name}, from Nooks. Millimetres, y up. Vertex colours are the brick colours.\no ${name.replace(/\s+/g, '_')}\n${v.join('\n')}\n${f.join('\n')}\n`;
}

export function toGLB(items, { name = 'Nooks model' } = {}) {
  const at = frame(items, 'y'), byColour = new Map();
  eachTriangle(items, (A, B, C, code) => {
    const a = at(A).map((x) => x / 1000), b = at(B).map((x) => x / 1000), c = at(C).map((x) => x / 1000), n = normal(a, b, c);
    let g = byColour.get(code);
    if (!g) byColour.set(code, (g = { p: [], n: [] }));
    g.p.push(...a, ...b, ...c); g.n.push(...n, ...n, ...n);
  });
  const chunks = [], views = [], accessors = [], materials = [], primitives = [];
  let offset = 0;
  const push = (arr, target) => { const bytes = new Uint8Array(Float32Array.from(arr).buffer); chunks.push(bytes); views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target }); offset += bytes.length; return views.length - 1; };
  for (const [code, g] of byColour) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < g.p.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], g.p[i + k]); hi[k] = Math.max(hi[k], g.p[i + k]); }
    const pv = push(g.p, 34962), nv = push(g.n, 34962), count = g.p.length / 3;
    accessors.push({ bufferView: pv, componentType: 5126, count, type: 'VEC3', min: lo, max: hi }, { bufferView: nv, componentType: 5126, count, type: 'VEC3' });
    const col = BY_CODE.get(code), [r, gg, b] = rgbOf(code).map((x) => { const c = x / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    const trans = /trans/i.test(col?.name ?? '');
    materials.push({ name: col?.name ?? String(code), pbrMetallicRoughness: { baseColorFactor: [r, gg, b, trans ? 0.6 : 1], metallicFactor: 0, roughnessFactor: 0.45 }, ...(trans ? { alphaMode: 'BLEND' } : {}) });
    primitives.push({ attributes: { POSITION: accessors.length - 2, NORMAL: accessors.length - 1 }, material: materials.length - 1 });
  }
  const json = { asset: { version: '2.0', generator: 'Nooks' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name, mesh: 0 }], meshes: [{ name, primitives }], materials, accessors, bufferViews: views, buffers: [{ byteLength: offset }] };
  const enc = new TextEncoder().encode(JSON.stringify(json)), jl = Math.ceil(enc.length / 4) * 4, bl = Math.ceil(offset / 4) * 4;
  const out = new Uint8Array(12 + 8 + jl + 8 + bl), v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true); v.setUint32(4, 2, true); v.setUint32(8, out.length, true);
  v.setUint32(12, jl, true); v.setUint32(16, 0x4e4f534a, true); out.fill(0x20, 20, 20 + jl); out.set(enc, 20);
  const b0 = 20 + jl;
  v.setUint32(b0, bl, true); v.setUint32(b0 + 4, 0x004e4942, true);
  let o = b0 + 8;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export function exportModel(items, format, opts) {
  if (format === 'stl') return toSTL(items, opts);
  if (format === 'obj') return new TextEncoder().encode(toOBJ(items, opts));
  if (format === 'glb') return toGLB(items, opts);
  throw new Error('Export as stl, obj or glb.');
}
