// Editing a model by hand: add, remove, move, turn and recolour parts, then
// bring the model's derived data (steps, sections, inventory, catalogue,
// dimensions, connectivity) back in line. Pure: no DOM.
//
// The manual survives editing: parts keep stable keys, and the steps are
// re-planned against the steps before the edit (lib/planner.mjs `replan`),
// so earlier steps stay as they were and only what the edit forces moves.
import { replan, impact } from './planner.mjs';
import { CATALOG } from './parts.mjs';
import { BY_CODE } from './palette.mjs';
import { reach, holdingLeg } from './figures.mjs';
import { asBrick, space } from './place.mjs';
import { studKind, studPoints, inside, studsInto, faceJoin, sideStuds, boxMM } from './studs.mjs';

const footprint = (p) => (p.rotation === 90 || p.rotation === 270 ? [p.d, p.w] : [p.w, p.d]);
const cellsOf = (p) => {
  const [fx, fz] = footprint(p), x0 = p.x - fx / 2, z0 = p.z - fz / 2, out = [];
  for (let i = 0; i < fx; i++) for (let k = 0; k < fz; k++) out.push(`${x0 + i},${z0 + k}`);
  return out;
};

// Parts that hold each other: a stud of one goes into the underside of the
// other (lib/studs.mjs: where each part really has studs, a slope only on
// its high side, a tile none), wherever the two sit (half a stud apart on a
// jumper too). Returns the connected groups, largest first, and which parts
// are not in the largest one.
// Grid keys as small numbers, not strings (a model of 16,000 parts looks up
// about 100,000 studs on each edit): one map per height level, a stud column
// in it as one small integer while it fits (130 m of studs either way, which
// the engine keeps unboxed); past that, a string.
const colKey = (x, z) => (Math.abs(x) < 16384 && Math.abs(z) < 16384 ? (x + 16384) * 32768 + (z + 16384) : `${x},${z}`);
// A floor cell by its corner, to a quarter stud.
const floorKey = (x, z) => { const qx = Math.round(x * 4), qz = Math.round(z * 4); return Math.abs(qx) < 2 ** 25 && Math.abs(qz) < 2 ** 25 ? (qx + 2 ** 25) * 2 ** 26 + (qz + 2 ** 25) : `${x},${z}`; };

// The parts by where their boxes are (16 mm cells): `near(i)` lists the parts
// whose boxes meet part i's to within 2.3 mm, which is as far as a face join
// reaches (lib/studs.mjs faceJoin).
function boxHash(parts) {
  const CELL = 16, PAD = 2.3, cells = new Map(), stamp = new Int32Array(parts.length).fill(-1);
  const key = (a, b, c) => ((a + 4096) * 8192 + (b + 4096)) * 8192 + (c + 4096);
  const box = parts.map(boxMM);
  const each = (b, f) => {
    const x1 = Math.floor((b[3] + PAD) / CELL), y1 = Math.floor((b[4] + PAD) / CELL), z1 = Math.floor((b[5] + PAD) / CELL);
    for (let x = Math.floor((b[0] - PAD) / CELL); x <= x1; x++) for (let y = Math.floor((b[1] - PAD) / CELL); y <= y1; y++) for (let z = Math.floor((b[2] - PAD) / CELL); z <= z1; z++) f(key(x, y, z));
  };
  box.forEach((b, i) => each(b, (k) => { const c = cells.get(k); if (c) c.push(i); else cells.set(k, [i]); }));
  return {
    near(i) {
      const out = [], A = box[i];
      each(A, (k) => {
        for (const j of cells.get(k) ?? []) {
          if (j === i || stamp[j] === i) continue;
          stamp[j] = i;
          const B = box[j];
          if (A[0] <= B[3] + PAD && B[0] <= A[3] + PAD && A[1] <= B[4] + PAD && B[1] <= A[4] + PAD && A[2] <= B[5] + PAD && B[2] <= A[5] + PAD) out.push(j);
        }
      });
      return out;
    },
  };
}

// `links` (optional): the connection graph (lib/graph.mjs) or anything with
// `links(part)`; parts it joins (pins, axles, bars in clips, hinges) hold each
// other too. Without it: studs and touch only, as always.
export function connectivity(model, links = null) {
  const parts = model.parts, n = parts.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  // Footprints, worked out once (the loops below compare parts in pairs).
  const FX = new Float64Array(n), FZ = new Float64Array(n);
  parts.forEach((p, i) => { [FX[i], FZ[i]] = footprint(p); });
  // Undersides by height and stud column, then every stud looked up there.
  const level = (y) => Math.round(y * 4);
  const under = new Map();                               // level → stud column → part index (or indices)
  parts.forEach((p, i) => {
    if (p.origin) return;
    const fx = FX[i], fz = FZ[i], l = level(p.y);
    let cols = under.get(l);
    if (!cols) under.set(l, (cols = new Map()));
    for (let x = Math.floor(p.x - fx / 2 + 1e-6); x < p.x + fx / 2 - 1e-6; x++) for (let z = Math.floor(p.z - fz / 2 + 1e-6); z < p.z + fz / 2 - 1e-6; z++) {
      // (one part in a cell, as almost always: just its index; an array only for more)
      const k = colKey(x, z), had = cols.get(k);
      if (had === undefined) cols.set(k, i); else if (typeof had === 'number') cols.set(k, [had, i]); else had.push(i);
    }
  });
  const join = (i, j, pt) => { if (j !== i && inside(parts[j], pt)) parent[find(i)] = find(j); };
  parts.forEach((p, i) => {
    const cols = under.get(level(p.y + p.h));
    if (!cols) return;
    for (const pt of studPoints(p, model.catalog)) {
      const at = cols.get(colKey(Math.floor(pt[0]), Math.floor(pt[1])));
      if (typeof at === 'number') join(i, at, pt); else if (at) for (const j of at) join(i, j, pt);
    }
  });
  // Figure parts, plants, parts turned off the grid (a brick on its side)
  // and other special elements hold by pins, clips and side studs: they
  // count as attached to anything they touch or overlap.
  let boxes = null;
  const special = (p) => p.origin || p.inset || p.shape === 'custom' || /^(tree|bush|leaves|flower)/.test(p.shape ?? '') || model.catalog?.[p.id]?.shape === 'custom';
  parts.forEach((p, i) => {
    // Parts on their side, and bricks with side studs: face to face (lib/studs.mjs faceJoin).
    // (only parts whose boxes meet can click together, so those are asked, not every part: a poster of 8,000 turned parts was 90 million asks)
    if (p.extent || sideStuds(p, model.catalog)) for (const j of (boxes ??= boxHash(parts)).near(i)) if ((p.extent || parts[j].extent) && faceJoin(p, parts[j], model.catalog)) parent[find(i)] = find(j);
    if (!special(p) || p.extent) return;
    const fx = FX[i], fz = FZ[i], low = p.origin ? p.y - reach(p) : p.y;   // a figure piece's y is its LDraw origin: legs stand up to 3.5 plates below it (a skirt 5)
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const q = parts[j];
      if (Math.abs(p.x - q.x) < (fx + FX[j]) / 2 && Math.abs(p.z - q.z) < (fz + FZ[j]) / 2 && q.y <= p.y + p.h && low <= q.y + q.h) parent[find(i)] = find(j);
    }
  });
  // Plates side by side on the base layer are one base (baseplates laid out
  // on a table), joined where their edges meet.
  let floor = Infinity;
  for (const p of parts) if (!p.origin && p.y < floor) floor = p.y;
  const onFloor = [];
  parts.forEach((p, i) => { if (p.y === floor && !p.origin) onFloor.push(i); });
  const floorCells = new Map();
  const eachCell = (i, f) => { const x0 = parts[i].x - FX[i] / 2, z0 = parts[i].z - FZ[i] / 2; for (let a = 0; a < FX[i]; a++) for (let b = 0; b < FZ[i]; b++) f(x0 + a, z0 + b); };
  for (const i of onFloor) eachCell(i, (x, z) => floorCells.set(floorKey(x, z), i));
  for (const i of onFloor) eachCell(i, (x, z) => {
    for (const k of [floorKey(x + 1, z), floorKey(x - 1, z), floorKey(x, z + 1), floorKey(x, z - 1)]) { const j = floorCells.get(k); if (j !== undefined && j !== i) parent[find(i)] = find(j); }
  });
  if (links) {
    // (the graph's connector joints, when it can list just those; else every part asked)
    let at = null;
    const meet = (a, b) => { at ??= new Map(parts.map((p, i) => [p, i])); const i = at.get(a), j = at.get(b); if (i !== undefined && j !== undefined) parent[find(i)] = find(j); };
    if (links.pairs) links.pairs(meet); else for (const p of parts) for (const q of links.links(p)) meet(p, q);
  }
  const groups = new Map();
  parts.forEach((_, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); });
  const list = [...groups.values()].sort((a, b) => b.length - a.length);
  const main = new Set(list[0] ?? []);
  // Which group each part is in (by key; 0 is the main one), for telling a
  // part that hangs in the air from one held by a group already apart.
  const groupOf = new Map();
  list.forEach((g, n) => { for (const i of g) groupOf.set(parts[i].key, n); });
  return { groups: list.length, loose: parts.map((p, i) => i).filter((i) => !main.has(i)).map((i) => parts[i].key), groupOf };
}

// Who holds whom, asked part by part: the same links connectivity() joins
// (studs into undersides both ways, figures and plants by what they touch,
// parts on their side face to face, floor plates edge to edge), each found
// from the part's own neighbourhood. For questions about a few parts (what
// taking one away leaves hanging) on a model too big to work out whole each
// time. `links(p)` gives the parts linked to part p.
// Kept by part, not by place in the list, so an edit need not make it again:
// `from` (the index before some edits) and `edits` (what each did, oldest
// first: { added, removed, changed: [[part, …]] }) give it with only the parts
// those touched taken out and put back. Made whole, a model of 16,000 parts
// took a tenth of a second after every edit. `from` is spent by it.
export function linkIndex(model, from = null, edits = null) {
  const cat = model.catalog;
  const level = (y) => Math.round(y * 4);
  const studded = (p) => studKind(p, cat) !== 'none';
  const isSpecial = (p) => p.origin || p.inset || p.shape === 'custom' || /^(tree|bush|leaves|flower)/.test(p.shape ?? '') || cat?.[p.id]?.shape === 'custom';
  // level → stud column → the parts there: undersides by their level, and
  // tops by theirs (a part with studs, on its footprint's cells; which of
  // its studs reach is checked when asked). `info`: part → its footprint,
  // studs (when asked) and where it was put, to take it out again.
  let ix;
  const cellsUnder = (p, fx, fz) => { const out = []; for (let x = Math.floor(p.x - fx / 2 + 1e-6); x < p.x + fx / 2 - 1e-6; x++) for (let z = Math.floor(p.z - fz / 2 + 1e-6); z < p.z + fz / 2 - 1e-6; z++) out.push(colKey(x, z)); return out; };
  const add = (m, l, k, p) => { let cols = m.get(l); if (!cols) m.set(l, (cols = new Map())); const had = cols.get(k); if (had) had.push(p); else cols.set(k, [p]); };
  const drop = (m, l, k, p) => { const cols = m.get(l), had = cols?.get(k), i = had ? had.indexOf(p) : -1; if (i < 0) return; had.splice(i, 1); if (!had.length) cols.delete(k); };
  const onFloor = (p) => !p.origin && p.y === ix.floor;
  const floorCells = (p, e) => { const out = [], x0 = p.x - e.fx / 2, z0 = p.z - e.fz / 2; for (let a = 0; a < e.fx; a++) for (let b = 0; b < e.fz; b++) out.push(floorKey(x0 + a, z0 + b)); return out; };
  const putFloor = (p, e) => { e.floor = onFloor(p) ? floorCells(p, e) : null; for (const k of e.floor ?? []) ix.floorAt.set(k, p); };
  const takeFloor = (p, e) => { for (const k of e.floor ?? []) if (ix.floorAt.get(k) === p) ix.floorAt.delete(k); e.floor = null; };
  function put(p) {
    const [fx, fz] = footprint(p), cells = cellsUnder(p, fx, fz);
    const e = { fx, fz, cells, low: p.origin ? null : level(p.y), top: studded(p) ? level(p.y + p.h) : null, studs: undefined, floor: null };
    for (const k of cells) { if (e.low !== null) add(ix.under, e.low, k, p); if (e.top !== null) add(ix.tops, e.top, k, p); }
    if (p.extent || sideStuds(p, cat)) ix.sided.add(p);
    if (isSpecial(p) && !p.extent) ix.specials.add(p);
    ix.info.set(p, e);
    putFloor(p, e);
  }
  function take(p) {
    const e = ix.info.get(p);
    if (!e) return;
    for (const k of e.cells) { if (e.low !== null) drop(ix.under, e.low, k, p); if (e.top !== null) drop(ix.tops, e.top, k, p); }
    ix.sided.delete(p); ix.specials.delete(p);
    takeFloor(p, e);
    ix.info.delete(p);
  }
  const lowest = () => { let f = Infinity; for (const p of model.parts) if (!p.origin && p.y < f) f = p.y; return f; };
  // Links already worked out (`known`), and for each part the parts whose
  // known links take it in (`by`): links go both ways, so a part changed
  // or gone is forgotten with every part that named it, and a part come is
  // forgotten by every part it links to now. A flood out from a part on a
  // mosaic asks some 1,500 parts their links: asked again, they are known.
  const forget = (p) => { const set = ix.known.get(p); if (!set) return; ix.known.delete(p); for (const q of set) ix.by.get(q)?.delete(p); };
  const forgetAround = (p) => { for (const q of [...(ix.by.get(p) ?? [])]) forget(q); forget(p); };
  let fresh = [];
  if (from?.ix && edits?.length) {
    ix = from.ix; from.ix = null;
    for (const ed of edits) {
      for (const p of ed.removed) { forgetAround(p); take(p); ix.by.delete(p); }
      for (const [p] of ed.changed) { forgetAround(p); take(p); put(p); fresh.push(p); }
      for (const p of ed.added) { forgetAround(p); take(p); put(p); fresh.push(p); }
    }
    // The floor moved (its lowest parts went, or one went lower): its plates again, and every link.
    const floor = lowest();
    if (floor !== ix.floor) { ix.floor = floor; ix.floorAt.clear(); for (const [p, e] of ix.info) putFloor(p, e); ix.known.clear(); ix.by.clear(); fresh = []; }
  } else {
    ix = { under: new Map(), tops: new Map(), info: new Map(), specials: new Set(), sided: new Set(), floorAt: new Map(), floor: lowest(), known: new Map(), by: new Map() };
    for (const p of model.parts) put(p);
  }
  const { under, tops, info, specials, sided, floorAt, known, by } = ix;
  const studsOf = (p) => { const e = info.get(p); return (e.studs ??= studPoints(p, cat)); };
  const touches = (s, q) => { const a = info.get(s), b = info.get(q), low = s.origin ? s.y - reach(s) : s.y; return Math.abs(s.x - q.x) < (a.fx + b.fx) / 2 && Math.abs(s.z - q.z) < (a.fz + b.fz) / 2 && q.y <= s.y + s.h && low <= q.y + q.h; };
  const faces = (s, q) => (s.extent || q.extent) && faceJoin(s, q, cat);
  // (figures, plants and parts on their side link by touching anything near: theirs are not kept)
  function links(p) {
    const had = known.get(p);
    if (had) return had;
    const out = linksOf(p);
    if (!info.has(p) || specials.has(p) || sided.has(p)) return out;
    known.set(p, out);
    for (const q of out) { let b = by.get(q); if (!b) by.set(q, (b = new Set())); b.add(p); }
    return out;
  }
  function linksOf(p) {
    const out = new Set(), e = info.get(p);
    if (!e) return out;
    // Its studs into the undersides above it.
    const up = under.get(level(p.y + p.h));
    if (up) for (const pt of studsOf(p)) for (const q of up.get(colKey(Math.floor(pt[0]), Math.floor(pt[1]))) ?? []) if (q !== p && inside(q, pt)) out.add(q);
    // The studs below it into its underside: a stud of a part below, in a
    // cell of its underside, inside it (as connectivity() pairs them).
    const dn = !p.origin && tops.get(level(p.y));
    if (dn) {
      const cells = new Set(e.cells), below = new Set();
      for (const k of cells) for (const q of dn.get(k) ?? []) if (q !== p) below.add(q);
      for (const q of below) for (const pt of studsOf(q)) if (cells.has(colKey(Math.floor(pt[0]), Math.floor(pt[1]))) && inside(p, pt)) { out.add(q); break; }
    }
    // Figures and plants: what they touch (both ways).
    if (specials.has(p)) for (const q of model.parts) { if (q !== p && info.has(q) && touches(p, q)) out.add(q); }
    for (const s of specials) if (s !== p && touches(s, p)) out.add(s);
    // Parts on their side and side studs: face to face (both ways).
    if (sided.has(p)) for (const q of model.parts) { if (q !== p && faces(p, q)) out.add(q); }
    for (const s of sided) if (s !== p && faces(s, p)) out.add(s);
    // Floor plates edge to edge.
    if (e.floor) { const x0 = p.x - e.fx / 2, z0 = p.z - e.fz / 2; for (let a = 0; a < e.fx; a++) for (let b = 0; b < e.fz; b++) { const x = x0 + a, z = z0 + b; for (const k of [floorKey(x + 1, z), floorKey(x - 1, z), floorKey(x, z + 1), floorKey(x, z - 1)]) { const q = floorAt.get(k); if (q !== undefined && q !== p) out.add(q); } } }
    return out;
  }
  // Parts come or moved: what they link to now forgets what it knew (it does not know them yet).
  for (const p of fresh) if (info.has(p)) for (const q of linksOf(p)) forget(q);
  return { links, has: (p) => info.has(p), ix };
}
export function leftHangingNear(model, parts, already = new Set(), index = null, { reach = 1500, whole = reach * 3 } = {}) {
  if (!index || model.parts.length < whole) return leftHanging(model, parts, already, index);
  const gone = new Set(parts.filter((p) => index.has(p))), seen = new Set(), loose = new Set();
  for (const g of gone) for (const c of index.links(g)) {
    if (gone.has(c) || seen.has(c)) continue;
    const piece = [c], mark = new Set([c]);
    let big = false;
    for (let k = 0; k < piece.length && !big; k++) for (const j of index.links(piece[k])) {
      if (gone.has(j) || mark.has(j)) continue;
      mark.add(j); piece.push(j);
      if (piece.length > reach) { big = true; break; }
    }
    for (const j of mark) seen.add(j);
    if (!big) for (const j of piece) loose.add(j);
  }
  // (in the model's order)
  return loose.size ? model.parts.filter((q) => loose.has(q) && !already.has(q.key)) : [];
}

// A whole build standing on the base: every part clicked together with
// `part` (on it, under it, and so on), stopping at the base, the layer the
// model stands on. Picks up a house off the baseplate in one go. Double-
// clicking the base itself gives the whole model.
export function buildOf(model, part) {
  const parts = model.parts;
  const floor = Math.min(...parts.filter((p) => !p.origin).map((p) => p.y));
  if (part.y === floor && !part.origin) return [...parts];
  const tops = new Map(), bottoms = new Map();
  const add = (m, k, p) => { if (!m.has(k)) m.set(k, []); m.get(k).push(p); };
  for (const p of parts) {
    if (p.y === floor && !p.origin) continue;
    for (const c of cellsOf(p)) { if (p.studs !== false) add(tops, `${c},${p.y + p.h}`, p); add(bottoms, `${c},${p.y}`, p); }
  }
  const special = (p) => p.origin || p.inset || p.shape === 'custom' || /^(tree|bush|leaves|flower)/.test(p.shape ?? '');
  const out = new Set([part]), queue = [part];
  while (queue.length) {
    const p = queue.shift();
    const near = [];
    for (const c of cellsOf(p)) {
      near.push(...(tops.get(`${c},${p.y}`) ?? []));                         // what it sits on
      if (p.studs !== false) near.push(...(bottoms.get(`${c},${p.y + p.h}`) ?? []));   // what sits on it
    }
    // Figures and plants hold by pins and clips: what they overlap.
    // A figure's pieces go together; a figure or plant goes with the part under it.
    if (special(p)) for (const q of parts) {
      if (q.y === floor && !q.origin) continue;
      if (p.origin && q.origin && q.assembly === p.assembly) near.push(q);
      else if (!q.origin && Math.abs(p.x - q.x) < 1 && Math.abs(p.z - q.z) < 1 && q.y + q.h <= p.y + 0.01 && q.y + q.h >= p.y - (p.origin ? reach(p) + 1 : 0.01)) near.push(q);
    }
    // And a part carries the figures and plants standing on it.
    for (const q of parts) if (special(q) && !out.has(q) && !p.origin && Math.abs(p.x - q.x) < 1 && Math.abs(p.z - q.z) < 1 && p.y + p.h <= q.y + 0.01 && p.y + p.h >= q.y - (q.origin ? reach(q) + 1 : 0.01)) near.push(q);
    for (const q of near) if (!out.has(q)) { out.add(q); queue.push(q); }
  }
  return [...out];
}

// Steps, sections, inventory, catalogue and size from the parts as they are.
// `previous`: the steps before the edit; returns what the edit did to them.
// Every part with a key of its own: a new part, or a copy carrying its
// original's key, gets the next free one. Cheap, so an edit can do it at
// once and leave the rest of recompute for later. (Keys seen are flags in an
// array when they are whole numbers from 0, as they are once rekeyed: on a
// mosaic of 16,000 parts a Set of them was most of the cost.)
export function rekey(model) {
  const parts = model.parts;
  let next = -1, low = 0;
  for (const p of parts) if (Number.isInteger(p.key)) { if (p.key > next) next = p.key; if (p.key < low) low = p.key; }
  next++;
  const flags = low >= 0 && next <= parts.length * 4 + 65536 ? new Uint8Array(next) : null, seen = flags ? null : new Set();
  for (const p of parts) {
    if (!Number.isInteger(p.key) || (flags ? flags[p.key] === 1 : seen.has(p.key))) p.key = next++;
    else if (flags) flags[p.key] = 1;              // (a new key is past every old one: never seen again)
    if (seen) seen.add(p.key);
    p.layer = p.y; p.stepLayer = p.y;
  }
}

// The parts' keys as flags in an array (1 for each), or null when they are
// not all whole numbers from 0 (or are spread too thin for an array).
function keyFlags(parts) {
  let max = -1;
  for (const p of parts) { const k = p.key; if (!Number.isInteger(k) || k < 0) return null; if (k > max) max = k; }
  if (max > parts.length * 4 + 65536) return null;
  const flags = new Uint8Array(max + 1);
  for (const p of parts) flags[p.key] = 1;
  return flags;
}

// Steps to draw by until the manual is planned again (recompute): the
// steps as they were without the parts gone, each new part at the end of
// the last step of its assembly (or of a step of its own at the end).
export function provisionalSteps(model, previous = model.steps) {
  // Which keys are parts (1), and which of those a step already has (2).
  const flags = keyFlags(model.parts), set = flags ? null : new Set(model.parts.map((p) => p.key)), placed = flags ? null : new Set();
  const steps = (previous ?? []).map((s) => {
    const parts = flags ? s.parts.filter((k) => flags[k] > 0) : s.parts.filter((k) => set.has(k));
    for (const k of parts) if (flags) flags[k] = 2; else placed.add(k);
    return { ...s, parts };
  });
  const lastOf = new Map();
  steps.forEach((s, n) => { if (!s.attach) lastOf.set(s.assembly, n); });
  for (const p of model.parts) {
    if (flags ? flags[p.key] === 2 : placed.has(p.key)) continue;
    const a = p.assembly ?? 'Your changes';
    if (!lastOf.has(a)) { steps.push({ parts: [], assembly: a, added: true }); lastOf.set(a, steps.length - 1); }
    steps[lastOf.get(a)].parts.push(p.key);
  }
  return steps;
}

export function recompute(model, previous = model.steps, links = null, { preserveSteps = false } = {}) {
  const parts = model.parts;
  rekey(model);
  model.steps = preserveSteps ? (previous ?? []).map(s => ({ ...s, parts: [...s.parts] })) : replan(model, previous ?? []);
  const change = impact(previous ?? [], model.steps);
  const sections = new Map(), inv = new Map();
  for (const p of parts) {
    sections.set(p.section ?? 'Model', (sections.get(p.section ?? 'Model') ?? 0) + 1);
    const k = `${p.id}|${p.color}`;
    inv.set(k, (inv.get(k) ?? 0) + 1);
    if (!model.catalog[p.id]) { const c = CATALOG.get(p.id); model.catalog[p.id] = { name: c?.name ?? p.id, w: p.w, d: p.d, h: p.h, ...(c?.shape ? { shape: c.shape } : {}) }; }
    if (!model.colors?.[p.color] && BY_CODE.get(p.color)) (model.colors ??= {})[p.color] = { name: BY_CODE.get(p.color).name, hex: BY_CODE.get(p.color).hex };
  }
  model.sections = [...sections].map(([name, count]) => ({ name, count }));
  // The same rows toModel writes (the parts list, the booklet and the CSV read them).
  model.inventory = [...inv].map(([k, quantity]) => {
    const [id, color] = k.split('|'), c = model.colors?.[color] ?? BY_CODE.get(Number(color));
    return { id, name: model.catalog[id]?.name ?? id, color: Number(color), colorName: c?.name ?? color, hex: c?.hex ?? '#888888', quantity };
  }).sort((a, b) => b.quantity - a.quantity);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y1 = 0;
  for (const p of parts) { const [fx, fz] = footprint(p); x0 = Math.min(x0, p.x - fx / 2); x1 = Math.max(x1, p.x + fx / 2); z0 = Math.min(z0, p.z - fz / 2); z1 = Math.max(z1, p.z + fz / 2); y1 = Math.max(y1, p.y + p.h); }
  model.dimensions = model.parts.length ? { length: Math.round((x1 - x0) * 8), width: Math.round((z1 - z0) * 8), height: +(y1 * 3.2).toFixed(1) } : { length: 0, width: 0, height: 0 };
  const c = connectivity(model, links);
  model.validation = { ...(model.validation ?? {}), valid: c.loose.length === 0, components: c.groups, floating: c.loose, checked: 'after editing' };
  model.provenance = { ...(model.provenance ?? {}), edited: true };
  return change;
}

// Parts that a part would pass through: footprints overlap and heights
// overlap. Pinned and organic parts (figures, plants) are left out: their
// shapes are not boxes.
const boxy = (p) => !p.origin && p.shape !== 'custom' && !/^(tree|bush|leaves|flower)/.test(p.shape ?? '');
export function collisions(model, part) {
  if (!boxy(part)) return [];
  const mine = new Set(cellsOf(part));
  return model.parts.filter((q) => q !== part && boxy(q) && q.y < part.y + part.h && part.y < q.y + q.h && cellsOf(q).some((c) => mine.has(c)));
}

// What a part stands on: parts whose tops meet its underside.
export function supports(model, part) {
  const mine = new Set(cellsOf(part));
  return model.parts.filter((q) => q !== part && q.y + q.h === part.y && cellsOf(q).some((c) => mine.has(c)));
}

// A new part of design `id` in `color`, its footprint's corner at stud
// (x0, z0), standing on plate `y`.
// `dims`: size from the parts catalogue, for parts the designer does not know.
export function newPart(id, color, x0, z0, y, section = 'Your changes', dims = null) {
  const c = CATALOG.get(id) ?? dims;
  const w = c?.w ?? 1, d = c?.d ?? 1, h = c?.h ?? 1;
  return { id, color, x: x0 + w / 2, z: z0 + d / 2, y, w, d, h, rotation: 0, section, ...(c?.shape ? { shape: c.shape } : {}), ...(c?.studs === false ? { studs: false } : {}), ...(c?.vw ? { vw: c.vw, vd: c.vd } : {}) };
}

// Turn a part a quarter turn about its own centre.
export function turn(p) {
  p.rotation = ((p.rotation || 0) + 90) % 360;
  // Keep the footprint on the stud grid: an odd/even mismatch shifts by half.
  const [fx, fz] = footprint(p);
  if ((fx % 2) !== (fz % 2)) { p.x += 0.5; p.z += 0.5; }
  return p;
}

// Where a part goes when dropped on a surface (the viewer's surfaceAt hit):
// on top of a face that points up, under one that points down, beside a wall
// at the height of the pointer, or on the desk. Always on the stud grid of
// what it lands against (kits sit half a stud off in places). `ground`: the
// grid offset and height for the desk ({ ox, oz }). Returns { x, z, y }.
export function snapTo(hit, part, ground = { ox: 0, oz: 0 }) {
  const [fx, fz] = footprint(part);
  const frac = (v) => ((v % 1) + 1) % 1;
  const hp = hit.part;
  let ox = ground.ox, oz = ground.oz, cx = hit.point.x, cz = hit.point.z, y = 0;
  if (hp) {
    const [hx, hz] = footprint(hp);
    ox = frac(hp.x - hx / 2); oz = frac(hp.z - hz / 2);
    const n = hit.normal;
    if (n.y > 0.5) y = hp.y + hp.h;
    else if (n.y < -0.5) y = hp.y - part.h;
    else {
      // Beside it: pushed out by half the part's own size, at the pointer's plate.
      y = Math.max(0, Math.floor(hit.point.y + 1e-6));
      if (Math.abs(n.x) >= Math.abs(n.z)) cx += Math.sign(n.x) * (fx / 2 + 0.01); else cz += Math.sign(n.z) * (fz / 2 + 0.01);
    }
  }
  const x0 = Math.round(cx - fx / 2 - ox) + ox, z0 = Math.round(cz - fz / 2 - oz) + oz;
  return { x: x0 + fx / 2, z: z0 + fz / 2, y };
}

// A part and everything resting on it, on up: what comes along when it is
// pulled up off the model by hand, as real bricks come apart. A part with
// another clicked on top cannot come up through it, so that one comes too,
// and what is on it, and so on. `index` (stackIndex): the parts by where
// their undersides are, made once and asked many times (the Hand asks on
// every part it hovers over). By half-stud cells, so a part half a stud off
// (on a jumper) is found too.
const halfCells = (p) => {
  const [fx, fz] = footprint(p), x0 = Math.round((p.x - fx / 2) * 2), z0 = Math.round((p.z - fz / 2) * 2), out = [];
  for (let i = 0; i < fx * 2; i++) for (let k = 0; k < fz * 2; k++) out.push(`${x0 + i},${z0 + k}`);
  return out;
};
const plateKey = (y) => Math.round(y * 64);
export function stackIndex(model) {
  const bottoms = new Map();
  for (const q of model.parts) for (const c of halfCells(q)) { const k = `${c},${plateKey(q.y)}`, had = bottoms.get(k); if (had) had.push(q); else bottoms.set(k, [q]); }
  return bottoms;
}
export function stackOn(model, part, index = stackIndex(model)) {
  const out = new Set([part]), queue = [part];
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i], top = plateKey(p.y + p.h);
    for (const c of halfCells(p)) for (const q of index.get(`${c},${top}`) ?? []) if (!out.has(q)) { out.add(q); queue.push(q); }
  }
  return [...out];
}

// What comes away when `part` is pulled up off the model by hand, as real
// bricks come apart: the part and what is clicked onto it from above (by
// its studs, or by pins and clips), and what is clicked onto those, on up. A
// part with another clicked on top cannot come up through it. Asked of the
// link index (linkIndex), which an edit keeps up to date, so the Hand can
// ask on every part it hovers over, on a model of any size.
export function pullOff(model, part, index = linkIndex(model)) {
  const bottom = (q) => (q.origin ? q.y - reach(q) : q.y);
  const out = [part], seen = new Set(out);
  for (let k = 0; k < out.length; k++) {
    const p = out[k], top = p.origin ? p.y : p.y + p.h;
    for (const q of index.links(p)) if (!seen.has(q) && bottom(q) >= top - 0.05) { seen.add(q); out.push(q); }
  }
  return out;
}

// A build apart from the main one (a car standing on the desk beside the
// house): every part clicked together with `part`, to be picked up whole, as
// a real one is. Null when `part` is in the main build (what it is clicked
// to reaches past `reach` parts, or half the model), which comes apart by
// the part instead (pullOff). `index`: linkIndex. `main`: a set to keep
// between questions until the next edit: the parts found to be in the main
// build go in it, and a part linked to one of them is in it too.
export function bodyOf(model, part, index = linkIndex(model), { reach = 1500, main = null } = {}) {
  if (main?.has(part)) return null;
  const out = [part], seen = new Set(out);
  const isMain = () => { if (main) for (const q of out) main.add(q); return null; };
  for (let k = 0; k < out.length; k++) for (const q of index.links(out[k])) {
    if (seen.has(q)) continue;
    if (main?.has(q)) return isMain();
    seen.add(q); out.push(q);
    if (out.length > reach || out.length * 2 >= model.parts.length) return isMain();
  }
  return out.length * 2 < model.parts.length ? out : isMain();
}

// The groups apart from the main build that stand on the desk, by their
// number in connectivity()'s groupOf: a build set down beside the model
// rests there; it is not "held by nothing". `floor`: the layer the model
// stands on.
export function deskBuilds(model, conn, floor = Math.min(...model.parts.filter((p) => !p.origin).map((p) => p.y))) {
  const low = new Map();
  for (const p of model.parts) {
    if (p.origin) continue;
    const g = conn.groupOf.get(p.key);
    if (g && !(low.get(g) <= p.y)) low.set(g, p.y);
  }
  return new Set([...low].filter(([, y]) => y <= floor + 1e-6).map(([g]) => g));
}

// Loose parts lined up on the desk (the workbench's Tidy up): each lying upright as it is turned, packed in rows by
// footprint with `gap` mm between them, so no two overlap. The rows start at (x, z) (mm, the first part's corner) and
// run along x for `width` mm before the next row starts further along z. → a pose for each part, in their order:
// [x, y, z] of its middle (mm, its underside on the table) and a quaternion, as the viewer's spares take one.
export function tidyPoses(parts, { x = 0, z = 0, width = 160, gap = 4 } = {}) {
  const STUD = 8, PLATE = 3.2;
  const size = parts.map((p) => {
    const turned = p.rotation === 90 || p.rotation === 270, w = p.vw ?? p.w, d = p.vd ?? p.d;
    return [(turned ? d : w) * STUD, (turned ? w : d) * STUD];
  });
  // Deepest first, then widest: rows of like parts, little lost between them.
  const order = parts.map((_, i) => i).sort((a, b) => size[b][1] - size[a][1] || size[b][0] - size[a][0] || a - b);
  const poses = new Array(parts.length);
  let cx = x, cz = z, row = 0;
  for (const i of order) {
    const [w, d] = size[i];
    if (cx > x && cx + w > x + width) { cx = x; cz += row + gap; row = 0; }
    const t = ((parts[i].rotation || 0) * Math.PI) / 360;
    poses[i] = [cx + w / 2, (parts[i].h * PLATE) / 2, cz + d / 2, 0, Math.sin(t), 0, Math.cos(t)];
    cx += w + gap; row = Math.max(row, d);
  }
  return poses;
}

// The base made bigger on one side ('west', 'east', 'north' or 'south'): a
// strip 8 studs deep of real plates along that edge, stacked from the base's
// bottom layer up to its surface, so it is level with the base and ready to
// build on: the top layer in the surface's colour, the hidden ones in the
// bottom layer's. Plates side by side on the bottom layer count as one base
// (connectivity), as baseplates laid out on a table do. Returns new parts.
// `dims(id)`: a part's { w, d } as modelled (w along x), from the parts
// index; `made(id, colour)`: the colour it is made in nearest that one.
const STRIP = [[8, '41539'], [6, '3036'], [4, '3035'], [2, '3034'], [1, '3460']];   // 8×8, 6×8, 4×8, 2×8, 1×8
export function growBase(model, side, { dims = (id) => CATALOG.get(id), made = (id, c) => c } = {}) {
  const solid = model.parts.filter((p) => !p.origin);
  const floor = Math.min(...solid.map((p) => p.y));
  const low = solid.filter((p) => p.y === floor);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of low) { const [fx, fz] = footprint(p); x0 = Math.min(x0, p.x - fx / 2); x1 = Math.max(x1, p.x + fx / 2); z0 = Math.min(z0, p.z - fz / 2); z1 = Math.max(z1, p.z + fz / 2); }
  // The surface along that edge: the commonest top among parts over the bottom layer's edge row.
  const nearEdge = (p) => { const [fx, fz] = footprint(p); return side === 'west' ? p.x - fx / 2 <= x0 + 1 : side === 'east' ? p.x + fx / 2 >= x1 - 1 : side === 'north' ? p.z - fz / 2 <= z0 + 1 : p.z + fz / 2 >= z1 - 1; };
  const commonest = (list, key) => { const n = new Map(); for (const p of list) n.set(key(p), (n.get(key(p)) ?? 0) + 1); return [...n].sort((a, b) => b[1] - a[1])[0]?.[0]; };
  const edge = solid.filter((p) => nearEdge(p) && p.y < floor + 6);
  const top = Math.max(floor + 1, commonest(edge, (p) => p.y + p.h) ?? floor + 1);
  const surface = commonest(edge.filter((p) => p.y + p.h === top), (p) => p.color) ?? 71;
  const bottom = commonest(low, (p) => p.color) ?? 71;
  const along = side === 'west' || side === 'east' ? z1 - z0 : x1 - x0;
  const parts = [];
  for (let y = floor; y < top; y++) {
    let at = 0;
    while (at < along - 1e-6) {
      const [len, id] = STRIP.find(([l]) => l <= along - at + 1e-6);
      const c = dims(id) ?? { w: 8, d: len };
      const p = { id, color: made(id, y === top - 1 ? surface : bottom), w: c.w, d: c.d, h: 1, y, section: 'Base', assembly: 'Base', edited: 'added' };
      // Turned a quarter when it is modelled the other way round; layers
      // laid alternately would lock better, but a strip this short holds by
      // its stack.
      const wantX = side === 'west' || side === 'east' ? 8 : len;
      p.rotation = c.w === wantX ? 0 : 90;
      if (side === 'west') { p.x = x0 - 4; p.z = z0 + at + len / 2; }
      else if (side === 'east') { p.x = x1 + 4; p.z = z0 + at + len / 2; }
      else if (side === 'north') { p.z = z0 - 4; p.x = x0 + at + len / 2; }
      else { p.z = z1 + 4; p.x = x0 + at + len / 2; }
      parts.push(p);
      at += len;
    }
  }
  return parts;
}

// A group of parts turned a quarter turn about the first one's centre (in
// place): positions swing round it, each part turns, and parts placed by an
// LDraw matrix (figure pieces) have the turn applied to it.
export function turnGroup(parts) {
  const cx = parts[0].x, cz = parts[0].z, R = [0, 0, 1, 0, 1, 0, -1, 0, 0];
  const mul = (A, B) => [0, 1, 2].flatMap((r) => [0, 1, 2].map((k) => A[r * 3] * B[k] + A[r * 3 + 1] * B[3 + k] + A[r * 3 + 2] * B[6 + k]));
  for (const p of parts) {
    const dx = p.x - cx, dz = p.z - cz;
    p.x = cx + dz; p.z = cz - dx;
    if (p.origin) p.ldMatrix = mul(R, p.ldMatrix ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    else p.rotation = ((p.rotation || 0) + 90) % 360;
  }
  return parts;
}

// An empty set to build from scratch: a 32 × 32 baseplate, named.
export function blankSet(name, colour = 2) {
  const model = {
    name: String(name ?? '').trim() || 'My set',
    parts: [{ id: '3811', color: colour, x: 0, z: 0, y: 0, w: 32, d: 32, h: 1, rotation: 0, key: 0, section: 'Base', assembly: 'Base' }],
    catalog: { 3811: { name: 'Baseplate 32 x 32', w: 32, d: 32, h: 1 } },
    colors: {}, sections: [], inventory: [], steps: [],
    validation: { valid: true, components: 1, floating: [] },
    provenance: { source: { kind: 'scratch' }, evidence: { design: 'built by hand from an empty baseplate' } },
  };
  recompute(model, []);
  model.provenance.edited = false;
  return model;
}

// ---- how parts hold together, for placing
// A part has studs on top unless it is a tile or a slope (or says it has
// none); every part's underside takes studs.
// Any studs on top at all (a slope's high side counts; lib/studs.mjs says where).
export const hasStuds = (p, catalog = {}) => studKind(p, catalog) !== 'none';
const near = (a, b) => Math.abs(a - b) < 0.01;
// Whether parts set down here would be held by the model: one of them sits
// on studs of a part below, or presses its own studs into a part above; a
// minifigure stands on a stud. `moving`: parts being moved (not holders).
export function heldBy(model, parts, moving = new Set()) {
  // Plates on their own LDraw matrix count as the plates they are.
  const mine = new Set(parts), others = model.parts.filter((q) => !mine.has(q) && !moving.has(q)).map((q) => asBrick(q, model.catalog) ?? q);
  const legs = holdingLeg(parts);
  // Legs on a stud, by the same half-stud check placing uses (figures sit
  // half a stud off the grid).
  if (legs) return space(model).stands(legs, new Set([...moving, ...parts]));
  return parts.some((c) => {
    if (c.origin) return false;
    return others.some((q) => !q.origin && (studsInto(q, c, model.catalog) || studsInto(c, q, model.catalog)));
  });
}
// The parts that would be left hanging if `parts` were taken away: what is
// no longer held to the rest (and was held before; `already` are the keys
// that were loose to begin with).
export function leftHanging(model, parts, already = new Set(), links = null) {
  const gone = new Set(parts);
  const rest = { ...model, parts: model.parts.filter((q) => !gone.has(q)) };
  const loose = new Set(connectivity(rest, links).loose);
  return rest.parts.filter((q) => loose.has(q.key) && !already.has(q.key));
}
