// 3D model files read into one triangle mesh: { positions, indices, colorAt, triangles, bounds }, y up, the shape
// lib/mesh.mjs voxelises and the workbench shows as a reference. Reads STL (binary or text), OBJ (with vertex
// colours where the file has them) and glTF 2.0 (.glb, or .gltf with its buffers inside), whose materials' base
// colours and vertex colours are kept; textures and compressed (Draco, meshopt) geometry are not read. Pure: bytes
// in, mesh out; no DOM, no network.

const WHITE = [235, 235, 235];

// `bytes`: Uint8Array; `name`: the file name (its extension says the format). `up`: 'y' (glTF's and most OBJ's) or
// 'z' (most STL's, from CAD and printing); left out, glTF and OBJ are y up and STL z up.
export function readMesh(bytes, name = 'model.glb', { up = null } = {}) {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
  const text = () => new TextDecoder().decode(bytes);
  let got;
  if (ext === 'stl') got = isAsciiStl(bytes) ? readAsciiStl(text()) : readBinaryStl(bytes);
  else if (ext === 'obj') got = readObj(text());
  else if (ext === 'glb' || ext === 'gltf') got = readGltf(bytes, ext);
  else throw new Error('Open a .glb, .gltf, .obj or .stl file.');
  if (!got.positions.length) throw new Error('That file has no triangles in it.');
  const zUp = (up ?? (ext === 'stl' ? 'z' : 'y')) === 'z';
  const P = got.positions;
  if (zUp) for (let i = 0; i < P.length; i += 3) { const y = P[i + 1]; P[i + 1] = P[i + 2]; P[i + 2] = -y; }
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { bounds.min[k] = Math.min(bounds.min[k], P[i + k]); bounds.max[k] = Math.max(bounds.max[k], P[i + k]); }
  const triColour = got.triColour, vColour = got.vertexColours;
  const I = got.indices;
  // The colour where a ray meets triangle `ti` at barycentric (l1, l2): its vertex colours blended, else its own.
  const colorAt = (ti, l1, l2) => {
    if (vColour) {
      const l0 = 1 - l1 - l2, a = I[ti * 3] * 3, b = I[ti * 3 + 1] * 3, c = I[ti * 3 + 2] * 3;
      return [0, 1, 2].map((k) => l0 * vColour[a + k] + l1 * vColour[b + k] + l2 * vColour[c + k]);
    }
    return triColour ? [triColour[ti * 3], triColour[ti * 3 + 1], triColour[ti * 3 + 2]] : WHITE;
  };
  return { positions: P, indices: I, colorAt, triangles: I.length / 3, bounds, coloured: !!(vColour || got.coloured) };
}

const isAsciiStl = (b) => {
  const head = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 512)));
  if (!/^\s*solid/.test(head)) return false;
  // A binary STL may still begin "solid": its size gives it away.
  return !(b.length >= 84 && 84 + new DataView(b.buffer, b.byteOffset).getUint32(80, true) * 50 === b.length);
};
function readBinaryStl(b) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength), n = v.getUint32(80, true);
  if (84 + n * 50 > b.length) throw new Error('That STL file is cut short.');
  const positions = new Float32Array(n * 9), indices = new Uint32Array(n * 3);
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50 + 12;
    for (let k = 0; k < 9; k++) positions[t * 9 + k] = v.getFloat32(o + k * 4, true);
    indices[t * 3] = t * 3; indices[t * 3 + 1] = t * 3 + 1; indices[t * 3 + 2] = t * 3 + 2;
  }
  return { positions, indices };
}
function readAsciiStl(s) {
  const p = [];
  for (const m of s.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) p.push(+m[1], +m[2], +m[3]);
  const n = Math.floor(p.length / 9);
  return { positions: Float32Array.from(p.slice(0, n * 9)), indices: Uint32Array.from({ length: n * 3 }, (_, i) => i) };
}

function readObj(s) {
  const v = [], col = [], out = [], outCol = [], idx = [];
  let anyColour = false;
  const vertex = (ref) => {
    let i = parseInt(ref.split('/')[0], 10);
    i = i < 0 ? v.length / 3 + i : i - 1;
    out.push(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]);
    outCol.push(col[i * 3] ?? 235, col[i * 3 + 1] ?? 235, col[i * 3 + 2] ?? 235);
    return out.length / 3 - 1;
  };
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'v') {
      v.push(+t[1], +t[2], +t[3]);
      if (t.length >= 7) { anyColour = true; const k = Math.max(+t[4], +t[5], +t[6]) <= 1 ? 255 : 1; col.push(+t[4] * k, +t[5] * k, +t[6] * k); } else col.push(235, 235, 235);
    } else if (t[0] === 'f' && t.length >= 4) {
      const ids = t.slice(1).map(vertex);
      for (let k = 1; k + 1 < ids.length; k++) idx.push(ids[0], ids[k], ids[k + 1]);
    }
  }
  return { positions: Float32Array.from(out), indices: Uint32Array.from(idx), vertexColours: anyColour ? Float32Array.from(outCol) : null };
}

// ---------------------------------------------------------------- glTF 2.0
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const ARRAYS = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
function readGltf(bytes, ext) {
  let json, bin = null;
  if (ext === 'glb') {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (v.getUint32(0, true) !== 0x46546c67) throw new Error('That is not a .glb file.');
    let o = 12;
    while (o + 8 <= bytes.length) {
      const len = v.getUint32(o, true), type = v.getUint32(o + 4, true), chunk = bytes.subarray(o + 8, o + 8 + len);
      if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk));
      else if (type === 0x004e4942) bin = chunk;
      o += 8 + len;
    }
  } else json = JSON.parse(new TextDecoder().decode(bytes));
  if (!json) throw new Error('That glTF file could not be read.');
  if ((json.extensionsRequired ?? []).some((e) => /draco|meshopt/i.test(e))) throw new Error('That model\'s geometry is compressed (Draco or meshopt). Export it again without compression.');
  const buffers = (json.buffers ?? []).map((b, i) => {
    if (b.uri === undefined) return bin;
    const m = /^data:[^;]*;base64,(.*)$/.exec(b.uri);
    if (!m) throw new Error(`That .gltf file keeps its geometry in another file (${b.uri}). Use a .glb instead.`);
    return Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
  });
  const accessor = (i) => {
    const a = json.accessors[i], bv = json.bufferViews[a.bufferView], buf = buffers[bv.buffer], T = ARRAYS[a.componentType], n = COMPONENTS[a.type];
    const stride = bv.byteStride && bv.byteStride !== n * T.BYTES_PER_ELEMENT ? bv.byteStride / T.BYTES_PER_ELEMENT : n;
    const start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0) + buf.byteOffset;
    const src = new T(buf.buffer.slice(start, start + (a.count - 1) * stride * T.BYTES_PER_ELEMENT + n * T.BYTES_PER_ELEMENT));
    const out = new Float32Array(a.count * n);
    for (let i2 = 0; i2 < a.count; i2++) for (let k = 0; k < n; k++) out[i2 * n + k] = src[i2 * stride + k];
    if (a.normalized) { const max = { 5121: 255, 5123: 65535, 5120: 127, 5122: 32767 }[a.componentType] ?? 1; for (let i2 = 0; i2 < out.length; i2++) out[i2] /= max; }
    return out;
  };
  const positions = [], indices = [], triColour = [];
  let coloured = false;
  const toSrgb = (c) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  const mul = (a, b) => { const o = new Array(16).fill(0); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
  const local = (n) => {
    if (n.matrix) return n.matrix;
    const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1], [tx, ty, tz] = n.translation ?? [0, 0, 0];
    return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0, 2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0, 2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
  };
  const visit = (ni, parent) => {
    const n = json.nodes[ni], M = mul(parent, local(n));
    if (n.mesh !== undefined) for (const p of json.meshes[n.mesh].primitives) {
      if ((p.mode ?? 4) !== 4 || p.attributes.POSITION === undefined) continue;
      const P = accessor(p.attributes.POSITION), C = p.attributes.COLOR_0 !== undefined ? accessor(p.attributes.COLOR_0) : null;
      const cn = C ? json.accessors[p.attributes.COLOR_0].type === 'VEC4' ? 4 : 3 : 0;
      const mat = json.materials?.[p.material]?.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
      if (p.material !== undefined || C) coloured = true;
      const base = positions.length / 3;
      for (let i = 0; i < P.length; i += 3) {
        const [x, y, z] = [P[i], P[i + 1], P[i + 2]];
        positions.push(M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]);
      }
      const I = p.indices !== undefined ? accessor(p.indices) : Float32Array.from({ length: P.length / 3 }, (_, i) => i);
      for (let t = 0; t + 2 < I.length; t += 3) {
        indices.push(base + I[t], base + I[t + 1], base + I[t + 2]);
        // One colour a triangle: its first vertex's colour times the material's.
        const v0 = I[t] * cn, f = (k) => toSrgb((C ? C[v0 + k] : 1) * mat[k]);
        triColour.push(f(0), f(1), f(2));
      }
    }
    for (const c of n.children ?? []) visit(c, M);
  };
  const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scene = json.scenes?.[json.scene ?? 0];
  for (const ni of scene?.nodes ?? json.nodes?.map((_, i) => i) ?? []) visit(ni, I4);
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices), triColour: Uint8Array.from(triColour), coloured };
}
