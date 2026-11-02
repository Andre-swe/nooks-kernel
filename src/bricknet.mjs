// BrickNet's connectors for the agent runtime: every part's connectors with their frames, the addresses agents use
// (stud[i], hole[i], pin[i], …), which pairs fit, and where a part goes when one of its connectors meets another.
// A port of BrickAgent's joints.py and BrickNet's tables (MIT, Kulits 2026); the data is ldraw/bricknet.json
// (scripts/bundle-bricknet.py). Pure: the caller loads the JSON and passes it to `load`.
//
// LDraw units and axes (-y up). A connector's frame: its position, its axis the frame's +Y column, its roll the +Z
// column, as BrickAgent prints them.
import { compose, inverse, spin, mul3, rot, transpose, dir, ID } from './pose.mjs';

export const TYPES = ['stud', 'open', 'hole', 'tube', 'post', 'axle', 'cross', 'pin', 'socket', 'bar', 'clip', 'hinge', 'ball', 'fixed'];
const STUD_MATES = [['hole', 'open'], ['hole', 'stud'], ['open', 'post'], ['open', 'tube'], ['stud', 'tube']];
const AXLE_MATES = [['axle', 'cross'], ['axle', 'socket'], ['bar', 'clip'], ['bar', 'cross'], ['pin', 'socket']];
const pairIn = (list, a, b) => list.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
export const AXLE_MIN_OVERLAP = 4;
const RX_PI = [1, 0, 0, 0, -1, 0, 0, 0, -1];

export class NoMate extends Error {}

// A frame from a label row's position and angles (degrees), as bricknet/data.py builds it.
function frameOf(x, y, z, pitch, roll, yaw) {
  const [ax, az, ay] = [pitch, roll, yaw].map((d) => (d * Math.PI) / 180);
  const cx = Math.cos(ax), cz = Math.cos(az), cy = Math.cos(ay), sx = Math.sin(ax), sz = Math.sin(az), sy = Math.sin(ay);
  const r = [cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx, cx * sz, cx * cz, -sx, -sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx];
  return { r: r.map((v) => (Math.abs(v) < 1e-12 ? 0 : v)), t: [x, y, z] };
}

// The tables, indexed: { stems: Map stem → { name, bounds, conns }, ours, byName, colours, mirror, seating }.
// A conn: { i, kind, sub, pol, length, frame, type, index }.
export function load(json) { return addParts(loadCore(json), json.parts); }

// The tables without any part's connectors, for a page that fetches them part by part (`core`: the JSON without
// `parts`, as coreOf gives it); addParts then adds the parts it gets. Everything that reads a part reads it through
// `stems`, so a part not added yet reads as not in the catalogue.
export function loadCore(core) {
  return { stems: new Map(), ours: core.ours, colours: core.colours, mirror: core.mirror, seating: core.seating, reverse: reverseOurs(core.ours) };
}
export function addParts(T, parts) {
  for (const [stem, p] of Object.entries(parts)) {
    if (T.stems.has(stem)) continue;
    const counts = new Map();
    const conns = p.c.map(([kind, sub, pol, length, x, y, z, pitch, roll, yaw], i) => {
      const type = kind === 'stud' || kind === 'hole' || kind === 'axle' ? sub : kind;
      const index = counts.get(type) ?? 0;
      counts.set(type, index + 1);
      return { i, kind, sub, pol, length, frame: frameOf(x, y, z, pitch, roll, yaw), type, index };
    });
    T.stems.set(stem, { stem, name: p.n, bounds: p.b, conns });
  }
  return T;
}
// The JSON's shared tables, and a search index: [stem, name, "type:count …"] per part, for finding parts by name and
// by their connectors (about 0.6 MB, against 14.5 MB for every part's connectors).
export const coreOf = ({ parts, ...core }) => core;
export function indexOf(json) {
  return Object.entries(json.parts).map(([stem, p]) => {
    const n = new Map();
    for (const [kind, sub] of p.c) { const t = kind === 'stud' || kind === 'hole' || kind === 'axle' ? sub : kind; n.set(t, (n.get(t) ?? 0) + 1); }
    return [stem, p.n, [...n].map(([t, k]) => `${t}:${k}`).join(' ')];
  });
}
function reverseOurs(ours) {
  const out = new Map();
  for (const [id, v] of Object.entries(ours)) {
    const [stem, matrix] = Array.isArray(v) ? v : [v, null];
    if (!out.has(stem) || id === stem) out.set(stem, { id, matrix });
  }
  return out;
}

// ---- parts by number or name
const DIM = /(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/g;
const words = (text) => String(text).toLowerCase().replace(DIM, (_, a, b) => [a, b].sort((p, q) => p - q).join('x')).split(/\s+/).filter(Boolean);
const wordCache = new WeakMap();
function nameWords(T) {
  let w = wordCache.get(T);
  if (!w) wordCache.set(T, (w = new Map([...T.stems.values()].map((p) => [p.stem, words(p.name)]))));
  return w;
}

// Parts held back: out of the tables, so nothing finds, describes or places them, and named with the reason when
// asked for (data/catalog/no-collision.json: parts with no collision mesh, which the physics check cannot test).
export function withhold(T, stems, why) {
  T.withheld ??= new Map();
  for (const s of stems) { T.stems.delete(s); T.withheld.set(s, why); }
  wordCache.delete(T);
  return T;
}

// A part number (ours or BrickNet's, with or without .dat) or a family-first title ("brick 2x4", "plate 1x3") →
// the BrickNet stem. Throws with a plain message on an unknown or ambiguous name. `allowed`: a Set of stems (an
// inventory) the part must be in.
export function resolve(T, what, allowed = null) {
  if (typeof what !== 'string' || !what.trim()) throw new NoMate('A part is a name or an LDraw part number.');
  const key = what.trim().toLowerCase().replace(/\.dat$/, '');
  const mapped = T.ours[key];
  const stem = Array.isArray(mapped) ? mapped[0] : mapped ?? key;
  if (T.withheld?.has(stem)) throw new NoMate(`${what} can't be built with here yet: ${T.withheld.get(stem)}`);
  if (T.stems.has(stem)) {
    if (allowed && !allowed.has(stem)) throw new NoMate(`${what} is not in the inventory.`);
    return stem;
  }
  const want = words(key);
  const ranked = [];
  for (const [s, have] of nameWords(T)) {
    if (allowed && !allowed.has(s)) continue;
    if (have[0] !== want[0] || !want.every((w) => have.includes(w))) continue;
    ranked.push([s, have.join(' ') !== want.join(' '), new Set(have).size]);
  }
  ranked.sort((a, b) => a[1] - b[1] || a[2] - b[2]);
  const best = ranked.filter((r) => r[1] === ranked[0]?.[1] && r[2] === ranked[0]?.[2]);
  if (best.length === 1) return best[0][0];
  if (best.length) throw new NoMate(`"${what}" is ${best.length} parts: ${best.slice(0, 8).map((r) => `${r[0]} (${T.stems.get(r[0]).name})`).join(', ')}`);
  throw new NoMate(`No part named "${what}" in the catalogue; find_parts ranks the closest.`);
}
export const partOf = (T, stem) => T.stems.get(stem) ?? (() => { throw new NoMate(`${stem} is not in the catalogue.`); })();

// A part's connectors of one type (or all), part-local.
export function connectorsOf(T, stem, type = null) {
  if (type !== null && !TYPES.includes(type)) throw new NoMate(`Unknown connector type ${type}; choose from ${TYPES.join(', ')}.`);
  const all = partOf(T, stem).conns;
  return type === null ? all : all.filter((c) => c.type === type);
}
// "stud[0..7], hole[0..7], tube[0..2]": a part's addresses, for messages.
export function addresses(T, stem) {
  const n = new Map();
  for (const c of partOf(T, stem).conns) n.set(c.type, (n.get(c.type) ?? 0) + 1);
  return [...n].map(([t, k]) => (k > 1 ? `${t}[0..${k - 1}]` : `${t}[0]`)).join(', ') || 'none';
}

// What a type fits, for messages.
export function mates(type) {
  const out = new Set();
  for (const [a, b] of [...STUD_MATES, ...AXLE_MATES]) { if (a === type) out.add(b); if (b === type) out.add(a); }
  return [...out].sort().join(', ') || 'the other polarity';
}
// Whether BrickNet lets two connectors join.
export function compatible(a, b) {
  if (new Set([a.kind, b.kind]).size === 2 && [a.kind, b.kind].includes('stud') && [a.kind, b.kind].includes('hole')) return pairIn(STUD_MATES, a.sub, b.sub);
  if (a.kind === 'axle' && b.kind === 'axle') return pairIn(AXLE_MATES, a.sub, b.sub);
  return a.kind === b.kind && ['hinge', 'ball', 'fixed'].includes(a.kind) && a.sub === b.sub && new Set([a.pol, b.pol]).size === 2 && [a.pol, b.pol].every((p) => p === 'in' || p === 'on');
}

// Socket ends that also carry a stud-taking hole (a pin's collar sits in their recess).
function socketFaces(T, stem, i) {
  const conns = partOf(T, stem).conns, c = conns[i], axis = [c.frame.r[1], c.frame.r[4], c.frame.r[7]];
  const out = new Set();
  for (const o of conns) {
    if (o.kind !== 'hole') continue;
    const d = o.frame.t.map((v, k) => v - c.frame.t[k]), along = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
    const off = Math.hypot(...d.map((v, k) => v - along * axis[k]));
    if (off < 1e-8 && Math.abs(Math.abs(along) - c.length) < 1e-8) out.add(Math.sign(along));
  }
  return out;
}

const axisOf = (p) => [p.r[1], p.r[4], p.r[7]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Where `source` (a connector of the part being placed, { stem, conn, pose: the part's pose in that frame, usually
// ID }) goes so that it meets `target` ({ stem, conn, pose: the target's world frame }): the source part's pose.
// The options are BrickAgent's: flip (opposes the axes; chosen when omitted), slide (LDU along an axle joint), yaw
// (degrees about the joint axis), seat ('auto' seats pin collars; 'center', '+end', '-end'), align ([u, v]: point
// source-local u along v), orient (the whole rotation, as a pose).
export function placement(T, target, source, { flip = null, slide = 0, yaw = 0, seat = 'auto', align = null, orient = null } = {}) {
  const a = target.conn, b = source.conn;
  if (!compatible(a, b)) throw new NoMate(`Incompatible: ${target.stem}.${a.type}[${a.index}] and ${source.stem}.${b.type}[${b.index}]; ${[...new Set([a.type, b.type])].map((t) => `${t} takes ${mates(t)}`).join('; ')}`);
  if (!Number.isFinite(yaw) || !Number.isFinite(slide)) throw new Error('yaw and slide must be finite numbers; use orient for other rotations.');
  if (![null, true, false].includes(flip)) throw new Error('flip is true, false or left out.');
  if (!['auto', 'center', '+end', '-end'].includes(seat)) throw new Error("seat is 'auto', 'center', '+end' or '-end'.");
  if (orient && (align || yaw !== 0)) throw new Error('Choose orient, or align and yaw.');
  const ap = target.pose, bp = source.pose;          // world frames of the two connectors
  let side = flip === null ? null : flip ? -1 : 1, angle = yaw, offset = slide;
  let u = null, v = null;
  if (align) {
    const [p, q] = align.map((w) => { const n = Math.hypot(...w); if (!(n > 1e-12)) throw new Error('align directions must be nonzero.'); return w.map((x) => x / n); });
    u = p; v = q;
  }
  const limit = a.length + b.length - Math.min(AXLE_MIN_OVERLAP, 2 * a.length, 2 * b.length);
  if (side === null && (a.kind === 'axle' || a.kind === 'hinge')) {
    if (orient) side = dot(axisOf(ap), dir(orient, axisOf(bp))) >= 0 ? 1 : -1;
    else if (align) { const s = dot(u, axisOf(bp)), t = dot(v, axisOf(ap)); if (Math.abs(s) > 1e-8 && Math.abs(t) > 1e-8) side = s * t > 0 ? 1 : -1; }
  }
  if (seat === 'auto' && a.kind === 'axle' && b.kind === 'axle' && new Set([a.sub, b.sub]).size === 2 && [a.sub, b.sub].includes('pin') && [a.sub, b.sub].includes('socket')) {
    const [pin, sock] = a.sub === 'pin' ? [target, source] : [source, target];
    const [direction, collar] = T.seating.pin[`${pin.stem}:${pin.conn.i}`] ?? [null, null];
    if (direction !== null) {
      const faces = socketFaces(T, sock.stem, sock.conn.i);
      const face = side === null ? (faces.size === 1 ? [...faces][0] : 1) : side * direction;
      const depth = (T.seating.socket[`${sock.stem}:${sock.conn.i}`] ?? [null, null])[(face + 1) / 2];
      const start = pin.conn.length + (collar && depth !== null && depth !== undefined ? depth : 0);
      side = face * direction;
      offset += pin === source ? face * (sock.conn.length - start) : direction * (start - sock.conn.length);
    }
  } else if (seat === '+end' || seat === '-end') {
    if (a.kind !== 'axle') throw new Error('An end seat needs an axle joint.');
    offset += (seat === '+end' ? 1 : -1) * (a.length - b.length);
  }
  side = side ?? 1;
  if (a.kind !== 'axle' && (slide || (side === -1 && a.kind !== 'hinge'))) throw new Error('slide needs an axle joint; flip needs an axle joint or a hinge.');
  if (a.kind === 'axle' && Math.abs(offset) > limit + 1e-8) {
    const shift = offset - slide;
    throw new NoMate(`slide ${slide} would disengage; here it can be ${(-limit - shift).toFixed(2)} to ${(limit - shift).toFixed(2)}`);
  }
  const r = side === -1 ? RX_PI : ID.r;
  let rotation;
  if (align) {
    const uu = rot(r, rot(transpose(bp.r), u)), vv = rot(transpose(ap.r), v);
    const radii = [Math.hypot(uu[0], uu[2]), Math.hypot(vv[0], vv[2])];
    if (Math.abs(uu[1] - vv[1]) > 1e-8 || Math.abs(radii[0] - radii[1]) > 1e-8) throw new NoMate('These directions cannot be aligned by turning about the joint axis.');
    if (Math.max(...radii) >= 1e-8) angle += (Math.atan2(uu[2] * vv[0] - uu[0] * vv[2], uu[0] * vv[0] + uu[2] * vv[2]) * 180) / Math.PI;
  }
  if (orient) rotation = mul3(mul3(mul3(transpose(ap.r), orient.r), bp.r), transpose(r));
  else rotation = spin([0, 1, 0], angle).r;
  if (a.kind === 'fixed') {
    if (!rotation.every((x, k) => Math.abs(x - ID.r[k]) < 1e-8)) throw new Error('This fixed connector has its own orientation; it cannot turn.');
  } else if (a.kind !== 'ball' && !(Math.abs(rotation[1]) < 1e-8 && Math.abs(rotation[4] - 1) < 1e-8 && Math.abs(rotation[7]) < 1e-8)) {
    throw new NoMate('That orientation would tilt the joint axis; only a ball joint tilts, the rest turn.');
  }
  return compose(compose(ap, { r: mul3(rotation, r), t: [0, offset, 0] }), inverse(bp));
}

// ---- describing a part, as BrickAgent's describe prints it: connector addresses, kinds, positions, axes, rolls
// and half-lengths (LDU, part-local); a regular grid of connectors as one line.
const r9 = (v) => +(+v).toFixed(4) + 0;
const fmtv = (v) => `(${v.map(r9).join(', ')})`;
function gridLine(group) {
  if (group.length < 3) return null;
  const at = group.map((c) => c.frame.t), axes = [0, 1, 2].map((k) => [...new Set(at.map((p) => r9(p[k])))].sort((a, b) => a - b));
  if (new Set(at.map((p) => p.map(r9).join())).size !== group.length || axes.reduce((n, u) => n * u.length, 1) !== group.length) return null;
  const even = axes.map((u) => u.length > 2 && new Set(u.slice(1).map((v, i) => r9(v - u[i]))).size === 1);
  const spans = axes.map((u, k) => (even[k] ? `${u[0]}..${u.at(-1)} step ${r9(u[1] - u[0])}` : u.join(', ')));
  const size = axes.filter((u) => u.length > 1).map((u) => u.length).join(' x ');
  return `${size} ${size.includes(' x ') ? 'grid' : 'in a row'} | ${spans.map((s, k) => `${'xyz'[k]}=${s}`).join(' | ')}`;
}
export function describe(T, what, type = null) {
  const stem = resolve(T, what), p = partOf(T, stem);
  const lines = [`${stem}: ${p.name}`, `bounds: (${fmtv(p.bounds[0])}, ${fmtv(p.bounds[1])}) LDU`, 'connectors: at/half-length in LDU; axis=frame +Y; roll=frame +Z (part-local)'];
  const key = (c) => `${c.type}${c.kind} sub=${c.sub}${c.pol ? ` polarity=${c.pol}` : ''}axis=${fmtv([c.frame.r[1], c.frame.r[4], c.frame.r[7]])} | roll=${fmtv([c.frame.r[2], c.frame.r[5], c.frame.r[8]])}${c.kind === 'axle' ? ` | half-length=${c.length}` : ''}`;
  const list = connectorsOf(T, stem, type);
  for (let i = 0; i < list.length;) {
    let j = i; while (j < list.length && key(list[j]) === key(list[i])) j++;
    const group = list.slice(i, j), [, kind, rest] = key(group[0]).split(''), grid = gridLine(group);
    if (grid) lines.push(`${group[0].type}[${group[0].index}..${group.at(-1).index}] ${kind} | ${grid} | ${rest}`);
    else for (const c of group) lines.push(`${c.type}[${c.index}] ${kind} | at=${fmtv(c.frame.t)} | ${rest}`);
    i = j;
  }
  return lines.join('\n');
}

// ---- the part search (docs/BUILD_BY_CONNECTOR.md, piece 5), on the search index (indexOf: [stem, name, "type:count
// …"] per part), so a page can search every part without every part's connectors.
// Connector words, longest first, and the type each names.
export const CONNECTOR_WORDS = [['axle hole', 'cross'], ['cross hole', 'cross'], ['pin hole', 'socket'], ['technic hole', 'socket'], ['ball socket', 'ball'], ['ball joint', 'ball'], ['tow ball', 'ball'], ['technic pin', 'pin'], ['bar holder', 'clip'],
  ['axles', 'axle'], ['axle', 'axle'], ['pins', 'pin'], ['pin', 'pin'], ['clips', 'clip'], ['clip', 'clip'], ['bars', 'bar'], ['bar', 'bar'], ['hinges', 'hinge'], ['hinge', 'hinge'], ['ball', 'ball'], ['studs', 'stud'], ['stud', 'stud'], ['tube', 'tube']];
const countsOf = (text) => new Map(String(text ?? '').split(' ').filter(Boolean).map((t) => { const [k, n] = t.split(':'); return [k, Number(n)]; }));
// The connector types a query asks for and the words left for the name: { types, words }.
export function connectorQuery(query) {
  let q = ` ${String(query).toLowerCase().replace(/(\d)\s*x\s*(\d)/g, '$1 $2').replace(/[^a-z0-9./ ]+/g, ' ')} `;
  const types = new Set();
  for (const [w, t] of CONNECTOR_WORDS) while (q.includes(` ${w} `)) { types.add(t); q = q.replace(` ${w} `, ' '); }
  return { types: [...types], words: q.match(/[a-z0-9./]+/g) ?? [] };
}
// Parts by name and connector words ("axle hole", "clip", "bar 3L", "ball socket", "Technic pin"), as find() ranks
// them: every connector type asked for among the part's connectors, every other word in its name or number; the
// names that also have the connector words first, then the shorter. → [{ stem, name, counts }]
export function findIndexed(rows, query, { limit = 60, allowed = null } = {}) {
  const { types, words } = connectorQuery(query), all = String(query).toLowerCase().match(/[a-z0-9./]+/g) ?? [];
  const out = [];
  for (const [stem, name, text] of rows) {
    if (allowed && !allowed.has(stem)) continue;
    const counts = countsOf(text);
    if (!types.every((t) => counts.get(t) > 0)) continue;
    const have = new Set([...(String(name).toLowerCase().replace(/(\d)\s*x\s*(\d)/g, '$1 $2').match(/[a-z0-9./]+/g) ?? []), stem]);
    if (!words.every((w) => have.has(w))) continue;
    out.push({ stem, name, counts, score: all.filter((w) => have.has(w)).length });
  }
  out.sort((a, b) => (b.stem === all.join('')) - (a.stem === all.join('')) || b.score - a.score || a.name.length - b.name.length || a.stem.localeCompare(b.stem));
  return out.slice(0, limit);
}
// The types a connector can join (lib/assembly.mjs pairs them; for hinges, balls and fixed joints the same type, its
// size and polarity aside).
export function matingTypes(conn) {
  const out = new Set();
  const pairs = conn.kind === 'stud' || conn.kind === 'hole' ? STUD_MATES : conn.kind === 'axle' ? AXLE_MATES : null;
  if (!pairs) return [conn.kind];
  for (const [a, b] of pairs) { if (a === conn.sub) out.add(b); if (b === conn.sub) out.add(a); }
  return [...out];
}
// "Fits here": the parts (index rows) with a connector that mates with `conn`, exactly by compatible() for those whose
// connectors are in T, by type for the rest. → Set of stems
export function fitsWith(T, conn, rows) {
  const types = matingTypes(conn), out = new Set();
  for (const [stem, , text] of rows) {
    const counts = countsOf(text);
    if (!types.some((t) => counts.get(t) > 0)) continue;
    const p = T?.stems.get(stem);
    if (p && !p.conns.some((c) => compatible(conn, c))) continue;
    out.add(stem);
  }
  return out;
}

// What fits a connector: the parts with a connector compatible() with `conn`, each with those connectors' addresses
// ("hole[0..7]"), the most used first when `rank(stem)` gives each a count, else the plainest (fewest connectors, then
// shortest name). `allowed`: a Set of stems to keep to.
// → [{ stem, name, by: [address, …] }]
export function fitting(T, conn, { allowed = null, limit = 30, rank = null } = {}) {
  const out = [];
  for (const p of T.stems.values()) {
    if (allowed && !allowed.has(p.stem)) continue;
    const fits = p.conns.filter((c) => compatible(conn, c));
    if (!fits.length) continue;
    const by = new Map();
    for (const c of fits) { if (!by.has(c.type)) by.set(c.type, []); by.get(c.type).push(c.index); }
    out.push({ stem: p.stem, name: p.name, n: p.conns.length, r: rank ? rank(p.stem) : 0, by:[...by].map(([t, list]) => (list.length > 1 && list.at(-1) - list[0] === list.length - 1 ? `${t}[${list[0]}..${list.at(-1)}]` : list.slice(0, 6).map((k) => `${t}[${k}]`).join(', ') + (list.length > 6 ? ', …' : ''))) });
  }
  out.sort((a, b) => b.r - a.r || a.n - b.n || a.name.length - b.name.length || a.stem.localeCompare(b.stem));
  return out.slice(0, limit).map(({ n, r, ...p }) => p);
}
// A connector by its address on a part ('stud[0]', 'hole[-1]'), as build programs write it.
export function connectorAt(T, stem, address) {
  const m = /^([a-z]+)\[(-?\d+)\]$/.exec(String(address).trim());
  if (!m) throw new NoMate(`Not a connector address: "${address}". Write type[index], as stud[0].`);
  const list = connectorsOf(T, stem, m[1]), k = Number(m[2]) < 0 ? list.length + Number(m[2]) : Number(m[2]);
  if (!list[k]) throw new NoMate(`${stem}: no ${address}; its connectors: ${addresses(T, stem)}`);
  return list[k];
}

// Parts by words, most specific first: [{ stem, name }]. `allowed`: a Set of stems to keep to.
export function find(T, query = '', { limit = 20, allowed = null } = {}) {
  const tokens = (t) => String(t).toLowerCase().replace(/(\d)\s*x\s*(\d)/g, '$1 $2').match(/[a-z0-9./]+/g) ?? [];
  const want = tokens(query);
  let named = null;
  try { named = resolve(T, query, allowed); } catch { /* not a single part */ }
  const out = [];
  for (const p of T.stems.values()) {
    if (allowed && !allowed.has(p.stem)) continue;
    const have = new Set([...tokens(p.name), p.stem]);
    const hits = want.filter((w) => have.has(w)).length;
    if (!want.length || p.stem === named || hits === want.length) out.push([p, hits]);
  }
  out.sort((a, b) => (a[0].stem !== named) - (b[0].stem !== named) || b[1] - a[1] || a[0].name.length - b[0].name.length || a[0].stem.localeCompare(b[0].stem));
  return out.slice(0, limit).map(([p]) => ({ stem: p.stem, name: p.name }));
}
