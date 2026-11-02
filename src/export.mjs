// Outputs. `toModel` emits the same JSON shape create.nooks.place already
// renders (parts / catalog / colors / sections / inventory / dimensions), plus
// `steps`, `validation` and `provenance` blocks it can ignore.

import { CATALOG } from './parts.mjs';
import { BY_CODE } from './palette.mjs';
import { assign, plan } from './planner.mjs';
import { review } from './review.mjs';
import { customLDraw } from './custom.mjs';

const STUD_MM = 8, PLATE_MM = 3.2, STUD_LDU = 20, PLATE_LDU = 8;

function sectionNames(mode, layers) {
  if (mode === 'mosaic') return (y) => (y === 0 ? 'Backing' : 'Picture');
  if (mode === 'place') {
    const bands = ['Low-rise', 'Mid-rise', 'High-rise', 'Towers'];
    return (y) => (y === 0 ? 'Baseplate' : y === 1 ? 'Streets' : bands[Math.min(bands.length - 1, Math.floor(((y - 2) / Math.max(1, layers - 2)) * bands.length))]);
  }
  const names = ['Base', 'Lower body', 'Upper body', 'Top'];
  return (y) => names[Math.min(names.length - 1, Math.floor((y / Math.max(1, layers)) * names.length))];
}

export function toModel(result, validation, { name = 'Untitled build', mode = 'relief', source = null } = {}) {
  const { parts, nx, ny, nz } = result;
  const section = sectionNames(mode, ny);
  const outParts = parts.map((p) => ({
    id: p.id,
    x: p.x0 + p.fx / 2 - nx / 2,
    z: p.z0 + p.fz / 2 - nz / 2,
    y: p.bottom,
    color: p.color,
    section: p.section ?? section(p.layer),
    rotation: p.rotation,
    w: p.w, d: p.d, h: p.h,
    key: p.key,
    layer: p.layer,
    ...(p.shape && p.shape !== 'box' ? { shape: p.shape } : {}),
    ...(p.studs === false ? { studs: false } : {}),
    ...(p.inset ? { inset: true } : {}),
    ...(p.vw ? { vw: p.vw, vd: p.vd } : {}),
    ...(p.stepLayer !== undefined ? { stepLayer: p.stepLayer } : {}),
  }));
  const catalog = {}, colors = {}, inv = new Map(), sections = new Map();
  for (const p of outParts) {
    const c = CATALOG.get(p.id);
    catalog[p.id] = { name: c.name, w: c.w, d: c.d, h: c.h, ...(c.shape ? { shape: c.shape } : {}), ...(c.side ? { side: c.side } : {}) };
    const col = BY_CODE.get(p.color);
    colors[p.color] = { name: col.name, hex: col.hex };
    const k = `${p.id}/${p.color}`;
    inv.set(k, (inv.get(k) || 0) + 1);
    sections.set(p.section, (sections.get(p.section) || 0) + 1);
  }
  const inventory = [...inv.entries()].map(([k, quantity]) => {
    const [id, color] = k.split('/');
    const col = BY_CODE.get(Number(color));
    return { id, name: CATALOG.get(id).name, color: Number(color), colorName: col.name, hex: col.hex, quantity };
  }).sort((a, b) => b.quantity - a.quantity);
  const heightPlates = parts.reduce((m, p) => Math.max(m, p.bottom + p.h), 0);
  const model = {
    name,
    parts: outParts,
    catalog,
    colors,
    sections: [...sections.entries()].map(([n, count]) => ({ name: n, count })),
    inventory,
    dimensions: {
      length: Math.round(nx * STUD_MM),
      width: Math.round(nz * STUD_MM),
      height: Math.round(heightPlates * PLATE_MM),
    },
    validation,
    notes: mode === 'mosaic'
      ? 'Studs-up mosaic on a staggered backing layer.'
      : 'Single-photo relief: silhouette inflated to a rounded body. Hidden interior uses free colours.',
    provenance: {
      generator: 'nooks-create-proto',
      version: '0.1.0',
      mode,
      source,
      createdAt: new Date().toISOString(),
      evidence: 'ai-inference',
    },
  };
  // Building steps from the step planner (lib/planner.mjs).
  assign(model);
  model.steps = plan(model);
  // The reviewer's pass (lib/review.mjs): checks, fixes, and says what it did.
  review(model);
  return model;
}

// One part as an LDraw line (type 1). This app's frame is LDraw's turned
// half a turn about x (y and z flip): LDraw x = x, y = −y, z = −z, and a
// rotation R becomes S·R·S with S = diag(1, −1, −1). Parts on their own
// matrix (figure pieces, parts turned off the grid) have y as their LDraw
// origin, in the same frame as a part's top face (lib/kits.mjs reads them
// the same way).
export function ldrawLine(p, geom = null) {
  const fmt = (v) => String(+v.toFixed(4));
  let m, X = p.x * STUD_LDU, Z = -p.z * STUD_LDU, Y;
  const g = !p.ldMatrix && geom ? geom(p.id) : null;
  if (p.ldMatrix) {
    const [a, b, c, d, e, f, g2, h, k] = p.ldMatrix;
    m = [a, -b, -c, -d, e, f, -g2, h, k].map(fmt).join(' ');
    Y = -p.y * PLATE_LDU;
  } else if (g) {
    // The geometry's middle on the footprint's middle, its underside on the part's.
    const t = (((p.rotation || 0) + ((p.shape ?? CATALOG.get(p.id)?.shape) === 'slope' ? g.slopeTurn ?? 0 : 0)) * Math.PI) / 180;
    const c = Math.round(Math.cos(t) * 1e6) / 1e6, s = Math.round(Math.sin(t) * 1e6) / 1e6;
    const ox = p.x * 8 - (c * g.cx + s * g.cz), oz = p.z * 8 - (-s * g.cx + c * g.cz);
    X = ox / 0.4; Z = -oz / 0.4; Y = -((p.y * 3.2 - g.minY) / 0.4);
    // App rotation [c 0 s; 0 1 0; −s 0 c] in LDraw's axes (S·R·S).
    m = [c, 0, -s, 0, 1, 0, s, 0, c].map(fmt).join(' ');
  } else {
    // A turn about y by 0 / 90 / 180 / 270 degrees; in LDraw, the other way.
    const r = -(p.rotation || 0) * Math.PI / 180, c = Math.round(Math.cos(r)), si = Math.round(Math.sin(r));
    m = `${c} 0 ${si} 0 1 0 ${-si} 0 ${c}`;
    Y = -(p.y + p.h) * PLATE_LDU;
    // Parts whose origin is off their middle (a slope's is on its stud).
    const off = CATALOG.get(p.id)?.ldOffset ?? 0;
    if (off) { X += si * off; Z += c * off; }
  }
  // A flexible part (lib/flex.mjs): its curve, as a meta line other programs skip, then the stock part at its start.
  const flex = p.flex ? `0 !NOOKS FLEX ${JSON.stringify({ kind: p.flex.kind, points: p.flex.points })}\n` : '';
  return `${flex}1 ${p.color} ${fmt(X)} ${fmt(Y)} ${fmt(Z)} ${m} ${p.id}.dat`;
}
const header = (name, file) => [`0 ${name}`, `0 Name: ${file}`, '0 Author: Nooks Create', '0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt', ''];
const fileOf = (name) => `${String(name).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'model'}.ldr`;

// LDraw .ldr with one STEP per build step, every part in one file.
// `geom(id)` → { cx, cz, minY, slopeTurn } (mm, this app's axes; see
// lib/studio.mjs fromLDraw): when given, every part goes where its own
// geometry puts it, the exact inverse of reading the file back in.
export function toLDraw(model, { geom = null } = {}) {
  const lines = header(model.name, `${model.name.replace(/[^\w -]/g, '').trim() || 'model'}.ldr`);
  const byKey = new Map(model.parts.map((p) => [p.key, p]));
  for (const step of model.steps) {
    for (const key of step.parts) lines.push(ldrawLine(byKey.get(key), geom));
    lines.push('0 STEP');
  }
  return lines.join('\n') + '\n';
}

// LDraw .mpd as desktop builders write it: the main build in the first file
// and every other sub-build (a minifigure, a section built on the side) as a
// submodel of its own with its own steps, placed in the main file where the
// manual attaches it. Parts keep their places (submodels go in unmoved), so
// reading it back gives the same model with its sub-builds.
export function toMPD(model, { geom = null } = {}) {
  const byKey = new Map(model.parts.map((p) => [p.key, p]));
  const steps = model.steps.filter((s) => s.parts.length || s.attach);
  const main = steps.find((s) => s.parts.length)?.assembly ?? null;
  const subs = new Map();          // assembly → { file, lines, last }
  steps.forEach((s, i) => {
    if (s.assembly === main || s.assembly == null) return;
    if (!subs.has(s.assembly)) subs.set(s.assembly, { file: fileOf(s.assembly), lines: header(s.assembly, fileOf(s.assembly)), last: i });
    const sub = subs.get(s.assembly);
    sub.last = i;
    if (!s.parts.length) return;
    for (const k of s.parts) sub.lines.push(ldrawLine(byKey.get(k), geom));
    sub.lines.push('0 STEP');
  });
  // Two sub-builds whose names make the same file name: numbered apart.
  const used = new Set([fileOf(model.name).toLowerCase()]);
  for (const sub of subs.values()) {
    let f = sub.file, n = 2;
    while (used.has(f.toLowerCase())) f = sub.file.replace(/\.ldr$/, ` ${n++}.ldr`);
    used.add(f.toLowerCase()); sub.file = f; sub.lines[1] = `0 Name: ${f}`;
  }
  // The main build's own sub-build name, as a meta line other programs skip.
  const out = [`0 FILE ${fileOf(model.name)}`, ...header(model.name, fileOf(model.name)), ...(main ? [`0 !NOOKS ASSEMBLY ${main}`, ''] : [])];
  steps.forEach((s, i) => {
    if (s.assembly === main || s.assembly == null) {
      for (const k of s.parts) out.push(ldrawLine(byKey.get(k), geom));
      if (s.parts.length) out.push('0 STEP');
    }
    // A sub-build goes in where the manual attaches it (after its last step).
    for (const sub of subs.values()) if (sub.last === i) out.push(`1 16 0 0 0 1 0 0 0 1 0 0 0 1 ${sub.file}`, '0 STEP');
  });
  out.push('0 NOFILE');
  for (const sub of subs.values()) out.push('', `0 FILE ${sub.file}`, ...sub.lines, '0 NOFILE');
  // Parts designed here go in as parts of their own (lib/custom.mjs).
  for (const id of new Set(model.parts.map((p) => p.id))) {
    const def = model.catalog?.[id];
    if (def?.custom) out.push('', `0 FILE ${id}.dat`, ...customLDraw(def).trimEnd().split('\n'), '0 NOFILE');
  }
  return out.join('\n') + '\n';
}

export function toCSV(model) {
  const rows = [['Part', 'Name', 'Color code', 'Color', 'Quantity']];
  for (const i of model.inventory) rows.push([i.id, i.name, i.color, i.colorName, i.quantity]);
  return rows.map((r) => r.map((v) => (/[",]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\n') + '\n';
}
