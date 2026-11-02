// The step planner: compiles any model (generated, a kit, or edited by hand)
// into building instructions that make sense. Pure: no DOM.
//
// Hard rules (never broken):
//   - in every stud column a part comes after every part below it there:
//     after what holds it up, and never slid in under something already
//     built (a roof or an overhang comes after what it covers).
//
// Preferences (what makes a manual read well):
//   - one assembly at a time, bottom up: the base, then each building or
//     section, then trees and details;
//   - as many steps as a real manual of that size has (about 2·n^0.62 for
//     n parts: some 70 for 300 pieces, 190 for 1,500), so no page is a
//     wasted one: small steps where something new happens, bigger ones for
//     a run of the same plates or tiles (a base course, a mosaic), a layer
//     finished in one step rather than leaving a few parts for the next;
//   - the same design together;
//   - a small thing that stands on one part (a figure, a tree, a chimney) is
//     built on the side, then attached in a step of its own;
//   - a part held up only from above (hanging under an overhang) goes on in
//     the step of what holds it, not steps before it in mid-air.
//
// After an edit, `replan(model, previous)` changes the manual as little as
// possible: parts keep their steps, new parts join the earliest step of their
// assembly the rules allow (never a step pinned by hand), and only what the
// rules force moves. `impact()`
// says what changed, `violations()` checks any manual against the rules.

import { insertionFindings } from './insertion.mjs';
import { studPoints, inside } from './studs.mjs';

const STEP_MAX = 12, STEP_MIN = 4;

// Step sizes for a model of n parts, from the step count a real manual of
// that size has.
export function budget(n) {
  const steps = Math.max(1, Math.round(2 * n ** 0.62));
  const max = Math.max(STEP_MAX, Math.ceil((1.4 * n) / steps));
  const min = Math.min(8, Math.max(STEP_MIN, Math.floor(max / 3)));
  return { steps, max, flat: Math.min(64, max * 3), min, target: Math.min(max, Math.max(min, Math.round(n / steps))) };
}

const footprint = (p) => (p.rotation === 90 || p.rotation === 270 ? [p.d, p.w] : [p.w, p.d]);
function cells(p) {
  const [fx, fz] = footprint(p), x0 = Math.floor(p.x - fx / 2 + 1e-6), z0 = Math.floor(p.z - fz / 2 + 1e-6), out = [];
  for (let i = 0; i < Math.max(1, Math.round(fx)); i++) for (let k = 0; k < Math.max(1, Math.round(fz)); k++) out.push(`${x0 + i},${z0 + k}`);
  return out;
}

// Each part's predecessors: the nearest part below it in each of its columns
// (parts at the same height in a column, like a figure's pieces, are not
// ordered against each other).
export function constraints(parts) {
  // Columns keyed by a small integer (a string only past 130 m of studs): run on every edit, for every part.
  const columns = new Map();
  parts.forEach((p, i) => {
    // A part laid on its side is not over or under anything in a stud
    // column: it goes on in the order its steps give (a picture built flat on
    // the side, then stood up; lib/display.mjs).
    if (p.extent) return;
    const [fx, fz] = footprint(p), x0 = Math.floor(p.x - fx / 2 + 1e-6), z0 = Math.floor(p.z - fz / 2 + 1e-6);
    for (let a = 0; a < Math.max(1, Math.round(fx)); a++) for (let b = 0; b < Math.max(1, Math.round(fz)); b++) {
      const x = x0 + a, z = z0 + b, c = Math.abs(x) < 16384 && Math.abs(z) < 16384 ? (x + 16384) * 32768 + (z + 16384) : `${x},${z}`;
      const list = columns.get(c);
      if (list) list.push(i); else columns.set(c, [i]);
    }
  });
  const before = parts.map(() => new Set());
  for (const list of columns.values()) {
    list.sort((a, b) => parts[a].y - parts[b].y);
    let lower = [];                                        // the parts at the last height below
    for (let k = 0; k < list.length;) {
      const y = parts[list[k]].y, same = [];
      while (k < list.length && parts[list[k]].y === y) same.push(list[k++]);
      for (const u of same) for (const l of lower) before[u].add(l);
      lower = same;
    }
  }
  return before;
}

// Height bands and other sections that say where a part is, not what it
// belongs to: these are re-derived as assemblies from the geometry.
const BANDS = new Set(['Ground', 'Lower', 'Middle', 'Upper', 'Top', 'Base', 'Lower body', 'Upper body', 'Baseplate', 'Streets', 'Low-rise', 'Mid-rise', 'High-rise', 'Towers', 'Picture', 'Backing']);
const special = (p) => !!p.origin || p.shape === 'custom' || /^(tree|bush|leaves|flower)/.test(p.shape ?? '');

// The assembly each part belongs to: its own `assembly`, its section when that
// names a thing (a kit's "Hull", "Saloon"), or, for parts placed by height
// band, the structure it is part of: the base (the lowest two plates) and
// each group of parts that hold each other above it.
export function assemblies(model) {
  const parts = model.parts, out = parts.map((p) => p.assembly ?? null);
  // A kit's sections are what its designer named; a generated model's may be height bands.
  const kit = model.provenance?.source?.kind === 'kit';
  const banded = parts.map((p, i) => out[i] == null && (p.section == null || (!kit && BANDS.has(p.section))));
  parts.forEach((p, i) => { if (out[i] == null && !banded[i]) out[i] = p.section; });
  if (banded.some(Boolean)) {
    // A base is a ground layer covering most of the model's footprint (a
    // place's baseplate and streets); a photo relief has none.
    const ground = new Set(), all = new Set();
    parts.forEach((p, i) => { if (!banded[i]) return; for (const c of cells(p)) { all.add(c); if (p.y === 0) ground.add(c); } });
    const hasBase = ground.size >= all.size * 0.8;
    const base = (p) => hasBase && p.y <= 1;
    // Structures: banded parts above the base that stack on each other.
    const idx = parts.map((_, i) => i).filter((i) => banded[i] && !base(parts[i]));
    const parent = new Map(idx.map((i) => [i, i]));
    const find = (i) => { while (parent.get(i) !== i) { parent.set(i, parent.get(parent.get(i))); i = parent.get(i); } return i; };
    const tops = new Map();
    for (const i of idx) for (const c of cells(parts[i])) tops.set(`${c},${parts[i].y + parts[i].h}`, i);
    for (const i of idx) for (const c of cells(parts[i])) { const j = tops.get(`${c},${parts[i].y}`); if (j !== undefined) parent.set(find(i), find(j)); }
    const groups = new Map();
    for (const i of idx) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }
    const list = [...groups.values()];
    // Named left to right, the order they are built in.
    const big = list.filter((g) => g.length >= 8).sort((a, b) => Math.min(...a.map((i) => parts[i].x)) - Math.min(...b.map((i) => parts[i].x)));
    const one = big.length <= 1;
    big.forEach((g, n) => { for (const i of g) out[i] = one ? 'Main build' : `Building ${n + 1}`; });
    for (const g of list) if (g.length < 8) for (const i of g) out[i] = one && !hasBase ? 'Main build' : 'Details';
    parts.forEach((p, i) => { if (banded[i] && base(p)) out[i] = 'Base'; });
  }
  // A group of figures (or other pinned parts) splits into one sub-assembly
  // per figure, each built on the side.
  const byName = new Map();
  parts.forEach((p, i) => { if (!byName.has(out[i])) byName.set(out[i], []); byName.get(out[i]).push(i); });
  for (const [nm, list] of byName) {
    const figs = list.filter((i) => special(parts[i]));
    if (figs.length < 3 || figs.length < list.length * 0.6) continue;
    const clusters = [];
    for (const i of figs) {
      const p = parts[i], c = clusters.find((cl) => cl.some((j) => Math.hypot(parts[j].x - p.x, parts[j].z - p.z) <= 1.01));
      if (c) c.push(i); else clusters.push([i]);
    }
    // A loose piece (a bouquet, a hat) goes with the nearest figure.
    for (const cl of clusters.filter((c) => c.length === 1)) {
      const p = parts[cl[0]], near = clusters.filter((c) => c.length > 1).sort((u, v) => Math.hypot(parts[u[0]].x - p.x, parts[u[0]].z - p.z) - Math.hypot(parts[v[0]].x - p.x, parts[v[0]].z - p.z))[0];
      if (near) { near.push(cl[0]); cl.length = 0; }
    }
    clusters.splice(0, clusters.length, ...clusters.filter((c) => c.length));
    if (clusters.length < 2) continue;
    clusters.forEach((cl, n) => { for (const i of cl) out[i] = `${nm} · ${n + 1}`; });
  }
  return out;
}

// A fresh plan: steps of { parts, assembly, aside?, attach? }.
// A list scheduler: a part becomes ready once everything under it is built;
// each step takes ready parts from the current assembly, so the rules hold
// by construction. The current assembly changes only when it is finished or
// waiting on another one.
export function plan(model) {
  const parts = model.parts, n = parts.length, before = constraints(parts), names = assemblies(model), baseBudget = budget(n);
  // Small and medium models get the close, readable steps used in a booklet.
  // Large builds keep the established course budget so their manuals remain practical.
  const B = n <= 500 ? { ...baseBudget, max: 6, flat: 6, min: 2, target: Math.min(4, baseBudget.target), compact: true } : baseBudget;
  const info = new Map();
  parts.forEach((p, i) => {
    if (!info.has(names[i])) info.set(names[i], { name: names[i], parts: [], y: Infinity, my: 0, x: 0, ready: new Set(), left: 0, outside: 0 });
    const s = info.get(names[i]); s.parts.push(i); s.y = Math.min(s.y, p.y); s.my += p.y; s.x += p.x; s.left++;
  });
  const succ = parts.map(() => []), waiting = new Int32Array(n);
  before.forEach((set, i) => { waiting[i] = set.size; for (const j of set) { succ[j].push(i); if (names[j] !== names[i]) info.get(names[i]).outside++; } });
  for (const s of info.values()) {
    s.x /= s.parts.length; s.my /= s.parts.length;
    // Built on the side: small, standing on just one part of its own (so it
    // holds together in the hand), resting on something else.
    const lowest = s.parts.filter((i) => parts[i].y === s.y);
    // (A figure stands on two legs, but its pieces hold together by their
    // pins: it counts too.)
    // (a copy of a sub-build is always built on the side: its own little build, then attached)
    s.aside = s.parts.length >= 2 && (s.parts.every((i) => parts[i].sub) || (s.parts.length <= 40 && (lowest.length === 1 || s.parts.every((i) => special(parts[i]))))) && s.outside > 0;
    for (const i of s.parts) if (!waiting[i]) s.ready.add(i);
  }
  // A kit's sections in its designer's order; otherwise bottom up by average
  // height (a base before the trees planted in it), then left to right.
  const listed = (model.sections ?? []).map((x) => x.name);
  const rank = (a) => (model.provenance?.source?.kind === 'kit' && listed.includes(a.name.split(' · ')[0]) ? listed.indexOf(a.name.split(' · ')[0]) : a.my);
  const order = [...info.values()].sort((a, b) => rank(a) - rank(b) || a.my - b.my || a.x - b.x);
  const finish = (i) => {
    const a = info.get(names[i]); a.ready.delete(i); a.left--;
    for (const u of succ[i]) {
      const b = info.get(names[u]);
      if (b !== a) b.outside--;
      if (--waiting[u] === 0) b.ready.add(u);
    }
  };
  const steps = [];
  let cur = null, left = n;
  while (left > 0) {
    if (!cur || !cur.left || !cur.ready.size) {
      // Next: the first assembly, bottom up, with parts ready (one built on
      // the side only once it can be attached).
      cur = order.find((s) => s.left && s.ready.size && (!s.aside || !s.outside)) ?? order.find((s) => s.left && s.ready.size);
      if (cur.aside && cur.outside) cur.aside = false;
    }
    let y = Infinity;
    for (const i of cur.ready) if (parts[i].y < y) y = parts[i].y;
    const byId = new Map();
    let count = 0, plates = true;
    for (const i of cur.ready) if (parts[i].y === y) { const k = parts[i].id; if (!byId.has(k)) byId.set(k, []); byId.get(k).push(i); count++; if (parts[i].h !== 1) plates = false; }
    // The same design together, the most used first; in a design, back to front, left to right.
    const groups = [...byId.values()].sort((u, v) => v.length - u.length);
    // A flat course (plates and tiles only: a base, a mosaic) goes down in
    // big steps; anything else in steps of a manual's usual size.
    const flat = count >= 16 && plates, cap = flat ? B.flat : B.max;
    // Finish the layer in this step when only a few would be left over;
    // else the first `cap` in that order, picked without ordering the whole
    // layer (a mosaic's layer is thousands of parts, a step takes dozens).
    const candidates = takeFirst(groups, B.compact ? count : count <= cap * 1.5 ? count : cap, parts);
    const pick = B.compact ? [] : candidates;
    const nearby = (p) => !B.compact || pick.every(i => Math.abs(p.x - parts[i].x) <= 8 && Math.abs(p.z - parts[i].z) <= 8 && Math.abs(p.y - parts[i].y) <= 3);
    if (B.compact) for (const i of candidates) { if (pick.length >= cap) break; if (nearby(parts[i])) pick.push(i); }
    for (const i of pick) finish(i);
    // A thin layer (a tower's few parts a course) is not a step on its own:
    // carry on up, lowest ready parts first, to a step's usual size.
    while (pick.length < B.target && cur.ready.size) {
      let i = -1;
      for (const j of cur.ready) if (nearby(parts[j]) && (i < 0 || parts[j].y < parts[i].y)) i = j;
      if (i < 0) break;
      pick.push(i); finish(i);
    }
    left -= pick.length;
    steps.push({ parts: pick.map((i) => parts[i].key), assembly: cur.name, ...(cur.aside ? { aside: true } : {}) });
    if (!cur.left && cur.aside) steps.push({ parts: [], assembly: cur.name, attach: true });
  }
  const out = merge(steps, parts, B);
  for (let guard = 0; guard < 8 && hang(out, parts, before, null, B.compact ? 6 : undefined); guard++);
  return repeats(improveInsertionOrder(out, parts), parts);
}

// Fresh plans only: try moving a blocked step before the step containing its obstruction
// by the earlier one, every moved part has an already-built stud support, and
// both the column rules and the insertion estimate improve. Hand-edited and
// saved plans are never passed here by replan(). Large and aside builds keep
// their existing schedule and expose any unresolved finding in the checker.
export function improveInsertionOrder(steps, parts) {
  if (parts.length > 256 || steps.some(s => s.aside || s.attach || s.pinned || s.edited)) return steps;
  const byKey = new Map(parts.map(p => [p.key, p]));
  const floor = Math.min(...parts.filter(p => !p.origin).map(p => p.y));
  let out = steps.slice(), result = insertionFindings({parts, steps:out});
  if (result.status === 'incomplete') return steps;
  for (let attempt = 0; attempt < 8; attempt++) {
    let changed = false;
    for (const finding of result.findings) {
      const n = finding.step - 1;
      if (n < 1 || finding.sameStep) continue;
      const target = out.findIndex((s, i) => i < n && s.parts.includes(finding.obstruction));
      // Do not move across an assembly boundary or a manually pinned step.
      if (target < 0 || out.slice(target, n).some(s => s.assembly !== out[n].assembly || s.attach || s.aside || s.pinned || s.edited)) continue;
      const earlier = out.slice(0,target).flatMap(s => s.parts.map(k => byKey.get(k))).filter(Boolean);
      const moving = out[n].parts.map(k => byKey.get(k));
      if (moving.some(p => !p || p.origin || !(p.w > 0 && p.d > 0 && p.h > 0))) continue;
      const supported = earlier.slice(), pending = moving.slice();
      for (let k = 0; k < pending.length;) {
        const p = pending[k];
        if (p.y <= floor || supported.some(q => !q.origin && Math.abs(q.y + q.h - p.y) < 0.01 && studPoints(q).some(pt => inside(p,pt)))) {
          supported.push(p); pending.splice(k,1); k = 0;
        } else k++;
      }
      if (pending.length) continue;
      const trial = out.slice(); trial.splice(target, 0, trial.splice(n, 1)[0]);
      if (violations({parts, steps:trial}).length > violations({parts, steps:out}).length) continue;
      const checked = insertionFindings({parts, steps:trial});
      if (checked.status === 'incomplete' || checked.findings.length >= result.findings.length) continue;
      out = trial; result = checked; changed = true; break;
    }
    if (!changed) break;
  }
  return out;
}

// Sub-builds as a manual shows them (docs/BUILD_BY_CONNECTOR.md, piece 2): a sub-build placed more than once is built
// once, its steps marked `times` (the boxed "×2"), and the other copies' own steps `repeat` (the booklet leaves them
// out; playing the build still shows each), each copy then attached in its own step. A copy whose parts differ (it
// was changed on its own) keeps its steps. The parts' `sub` (lib/subbuild.mjs) says which copy of which sub-build.
export function repeats(steps, parts) {
  const byKey = new Map(parts.map((p) => [p.key, p]));
  const runs = new Map();                                   // sub-build → [{ assembly, steps }] in manual order
  for (const s of steps) {
    if (s.attach || !s.parts.length) continue;
    const subs = new Set(s.parts.map((k) => byKey.get(k)?.sub?.s));
    if (subs.size !== 1 || subs.has(undefined)) continue;
    const id = [...subs][0];
    if (!runs.has(id)) runs.set(id, []);
    let run = runs.get(id).find((r) => r.assembly === s.assembly);
    if (!run) runs.get(id).push(run = { assembly: s.assembly, steps: [] });
    run.steps.push(s);
  }
  const out = steps.map((s) => { const t = { ...s }; delete t.times; delete t.repeat; return t; });
  const at = new Map(steps.map((s, n) => [s, out[n]]));
  // (copies alike as a whole: after edits one may have been planned in other steps, and is still the same build)
  const shape = (r) => r.steps.flatMap((s) => s.parts.map((k) => { const p = byKey.get(k); return `${p.id}|${p.color}|${p.sub.k}`; })).sort().join();
  for (const list of runs.values()) {
    if (list.length < 2) continue;
    const same = list.filter((r) => shape(r) === shape(list[0]));
    if (same.length < 2) continue;
    for (const s of same[0].steps) at.get(s).times = same.length;
    for (const r of same.slice(1)) for (const s of r.steps) at.get(s).repeat = true;
  }
  return out;
}

// The first `n` parts of `groups` (each a list of part indices, in order)
// once each group is ordered back to front, then left to right (ties keep
// their place: as a stable sort leaves them): whole groups while they fit,
// then the first few of the next, found without ordering all of it.
let rankOf = new Int32Array(0);                         // (reused: a part's place in its group)
function takeFirst(groups, n, parts) {
  const out = [];
  if (rankOf.length < parts.length) rankOf = new Int32Array(parts.length);
  for (const g of groups) {
    if (out.length >= n) break;
    for (let k = 0; k < g.length; k++) rankOf[g[k]] = k;
    const before = (u, v) => parts[u].z - parts[v].z || parts[u].x - parts[v].x || rankOf[u] - rankOf[v];
    const want = n - out.length;
    if (g.length <= want) { out.push(...g.slice().sort(before)); continue; }
    out.push(...smallest(g.slice(), want, before).sort(before));
  }
  return out;
}
// The `k` smallest of `a` by `cmp` (in no order): quickselect, in place.
function smallest(a, k, cmp) {
  let lo = 0, hi = a.length - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (cmp(a[i], pivot) < 0) i++;
      while (cmp(a[j], pivot) > 0) j--;
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (k - 1 <= j) hi = j; else if (k - 1 >= i) lo = i; else break;
  }
  return a.slice(0, k);
}

// The box a part takes up, in studs and plates: [x0, y0, z0, x1, y1, z1] (lib/mass.mjs's rule).
function box(p) {
  if (p.origin && p.extent) { const e = p.extent; return [p.x + e[0], p.y + e[1], p.z + e[2], p.x + e[3], p.y + e[4], p.z + e[5]]; }
  if (p.origin || !(p.w > 0 && p.d > 0 && p.h > 0)) return [p.x - 0.5, p.y - 4, p.z - 0.5, p.x + 0.5, p.y, p.z + 0.5];
  const [fx, fz] = footprint(p);
  return [p.x - fx / 2, p.y, p.z - fz / 2, p.x + fx / 2, p.y + p.h, p.z + fz / 2];
}

// A part that nothing holds up from below (a tile under an overhang, a lamp
// under a beam, a few bricks hanging under a bridge) is ready at once by the
// column rule, so it would go on in mid-air, steps before what holds it. It
// goes in with the first part above it instead: the same step, so the column
// rule still holds. Held up from below means standing, through parts resting
// on parts, on the table or on something no column holds (a part on its side,
// a wheel, a figure). Top down, so a chain hanging under a part follows it.
// Steps pinned by hand keep their parts, and a step never grows past one and a
// half flat courses (a roof of plates held only by the layer on it would be
// better built on the side). `only`: the indices of the parts that may move
// (after an edit, what it added or moved). (Changes `steps`; returns how many parts moved.)
function hang(steps, parts, before, only = null, cap = Math.floor(budget(parts.length).flat * 1.5)) {
  const index = new Map(parts.map((p, i) => [p.key, i])), stepOf = new Int32Array(parts.length).fill(-1);
  steps.forEach((s, n) => s.parts.forEach((k) => { const i = index.get(k); if (i !== undefined) stepOf[i] = n; }));
  let floor = Infinity;
  for (const p of parts) if (!p.origin && p.y < floor) floor = p.y;
  // Held up: bottom up, a part resting on one that is (box tops by height, to look only at those).
  const boxes = parts.map(box), held = new Uint8Array(parts.length), tops = new Map();
  const level = (y) => Math.round(y * 4);
  for (const i of parts.map((_, i) => i).sort((u, v) => boxes[u][1] - boxes[v][1])) {
    const p = parts[i], a = boxes[i];
    if (p.origin || p.extent || p.y <= floor) held[i] = 1;
    else for (const j of tops.get(level(a[1])) ?? []) {
      const b = boxes[j];
      if (b[0] < a[3] - 0.01 && b[3] > a[0] + 0.01 && b[2] < a[5] - 0.01 && b[5] > a[2] + 0.01) { held[i] = 1; break; }
    }
    if (held[i]) { const t = level(a[4]); if (tops.has(t)) tops.get(t).push(i); else tops.set(t, [i]); }
  }
  const above = parts.map(() => []);
  before.forEach((set, k) => { for (const i of set) above[i].push(k); });
  // Hanging: not held up, under a part (touching it) that is held up or hangs itself. (A stack held by
  // nothing at all, a model's own mistake, stays where the column rule put it.)
  const hung = new Uint8Array(parts.length), order = [];
  for (const i of parts.map((_, i) => i).filter((i) => !held[i]).sort((u, v) => parts[v].y - parts[u].y)) {
    const top = level(parts[i].y + parts[i].h);
    if (above[i].some((k) => level(parts[k].y) === top && (held[k] || hung[k]))) { hung[i] = 1; if (stepOf[i] >= 0 && (!only || only.has(i))) order.push(i); }
  }
  let moved = 0;
  for (const i of order) {
    const from = stepOf[i];
    if (steps[from].pinned) continue;
    const to = Math.min(...above[i].map((k) => stepOf[k]).filter((n) => n >= 0));
    if (!(to > from) || to === Infinity || steps[to].parts.length >= cap) continue;
    steps[from].parts = steps[from].parts.filter((k) => k !== parts[i].key);
    steps[to].parts.push(parts[i].key); stepOf[i] = to; moved++;
  }
  if (moved) {
    const kept = steps.filter((s) => s.parts.length || (s.attach && steps.some((t) => t.assembly === s.assembly && t.parts.length)));
    steps.splice(0, steps.length, ...kept);
  }
  return moved;
}

// A small step joins the one before it in the same assembly while the two
// stay within a step's size (consecutive steps: the order still holds).
// An assembly small enough for one step is one step.
function merge(steps, parts, B) {
  const byKey = new Map(parts.map((p) => [p.key, p]));
  const total = new Map();
  for (const s of steps) total.set(s.assembly, (total.get(s.assembly) ?? 0) + s.parts.length);
  const out = [];
  for (const s of steps) {
    const prev = out[out.length - 1];
    const local = !B.compact || !prev || (() => {
      const ps = [...prev.parts, ...s.parts].map(k => byKey.get(k)).filter(Boolean);
      return ['x','z'].every(axis => Math.max(...ps.map(p => p[axis])) - Math.min(...ps.map(p => p[axis])) <= 8)
        && Math.max(...ps.map(p => p.y)) - Math.min(...ps.map(p => p.y)) <= 3;
    })();
    if (prev && local && !prev.attach && !s.attach && prev.assembly === s.assembly && !!prev.aside === !!s.aside
      && ((prev.parts.length < B.min || s.parts.length < B.min || total.get(s.assembly) <= B.max) && prev.parts.length + s.parts.length <= B.max
        // The same course again (a wall going up): one step, not a run of identical ones.
        || (designs(prev, byKey) === designs(s, byKey) && prev.parts.length + s.parts.length <= B.flat))) {
      prev.parts.push(...s.parts);
      continue;
    }
    out.push({ ...s, parts: [...s.parts] });
  }
  return out;
}

// Which designs a step uses (a step's signature, colours aside).
const designs = (s, byKey) => [...new Set(s.parts.map((k) => byKey.get(k)?.id))].sort().join();

// The plan after an edit, changed as little as possible.
export function replan(model, previous) {
  if (!previous?.length) return plan(model);
  const parts = model.parts, before = constraints(parts), names = assemblies(model), B = budget(parts.length);
  const keys = new Set(parts.map((p) => p.key));
  const steps = previous.map((s) => ({ ...s, parts: s.parts.filter((k) => keys.has(k)) }));
  const stepOf = new Map();
  const reindex = () => { stepOf.clear(); steps.forEach((s, n) => s.parts.forEach((k) => stepOf.set(k, n))); };
  reindex();
  const index = new Map(parts.map((p, i) => [p.key, i]));
  const need = (i) => Math.max(-1, ...[...before[i]].map((j) => stepOf.get(parts[j].key) ?? -1));
  const place = (i) => {
    const p = parts[i], a = names[i], after = need(i);
    // A part sits on what it rests on: the first step of its assembly after that, with room.
    for (let n = after + 1; n < steps.length; n++) {
      const s = steps[n];
      if (s.attach || s.pinned || s.assembly !== a || s.parts.length >= B.max) continue;
      // Not into a step after something that must come after it (it would end up under it); its
      // step is fine (a part hanging under what holds it goes on with it).
      if (parts.some((q, j) => before[j].has(i) && stepOf.get(q.key) !== undefined && stepOf.get(q.key) < n)) break;
      s.parts.push(p.key); stepOf.set(p.key, n); return;
    }
    // Otherwise a new step, straight after what holds it, or at the end of its assembly.
    const last = steps.reduce((m, s, n) => (s.assembly === a ? n : m), -1);
    const at = Math.max(after, last) + 1;
    steps.splice(at, 0, { parts: [p.key], assembly: a, added: true });
    reindex();
  };
  const fresh = parts.map((_, i) => i).filter((i) => !stepOf.has(parts[i].key)).sort((u, v) => parts[u].y - parts[v].y);
  // A whole new sub-build (a minifigure dropped in) is planned as one: its
  // own steps (built on the side, then attached), at the end of the manual,
  // as a designer adds figures last, and so every existing step stays put.
  const known = new Set(steps.map((st) => st.assembly));
  const blocks = new Map();
  for (const i of fresh) if (!known.has(names[i])) { if (!blocks.has(names[i])) blocks.set(names[i], []); blocks.get(names[i]).push(i); }
  for (const [name, list] of blocks) {
    if (list.length < 2) continue;
    const own = new Set(list);
    const sub = plan({ ...model, parts: list.map((i) => ({ ...parts[i], assembly: name })), steps: [] });
    // Its steps never wait on its own parts, only on what is outside it.
    const after = Math.max(-1, ...list.flatMap((i) => [...before[i]].filter((j) => !own.has(j)).map((j) => stepOf.get(parts[j].key) ?? -1)));
    const outside = list.some((i) => [...before[i]].some((j) => !own.has(j)));
    const block = sub.map((st) => ({ ...st, added: true }));
    if (outside && !block.some((st) => st.attach)) { block.forEach((st) => { st.aside = true; }); block.push({ parts: [], assembly: name, attach: true, added: true }); }
    steps.splice(Math.max(after + 1, steps.length), 0, ...block);
    reindex();
  }
  fresh.filter((i) => !stepOf.has(parts[i].key)).forEach(place);
  const touched = new Set(fresh);
  // Repair: a part that now comes before something under it moves after it.
  for (let guard = 0; guard < 50; guard++) {
    let moved = false;
    for (let i = 0; i < parts.length; i++) {
      const n = stepOf.get(parts[i].key);
      if (n < need(i)) {
        steps[n].parts = steps[n].parts.filter((k) => k !== parts[i].key);
        stepOf.delete(parts[i].key);
        place(i); touched.add(i);
        moved = true;
      }
    }
    if (!moved) break;
  }
  // (only what the edit added or moved: the rest of a saved manual stays as it was)
  for (let guard = 0; guard < 8 && hang(steps, parts, before, touched); guard++);
  return repeats(steps.filter((s) => s.parts.length || (s.attach && steps.some((t) => t.assembly === s.assembly && t.parts.length)))
    .map((s) => ({ ...s, parts: s.parts.filter((k) => index.has(k)) })), parts);
}

// What an edit did to the manual.
export function impact(previous, next) {
  const was = new Map(), now = new Map();
  previous.forEach((s, n) => s.parts.forEach((k) => was.set(k, n)));
  next.forEach((s, n) => s.parts.forEach((k) => now.set(k, n)));
  const added = [...now.keys()].filter((k) => !was.has(k));
  const removed = [...was.keys()].filter((k) => !now.has(k));
  const sig = (s) => (s ? s.parts.join() : '');
  let same = 0;
  while (same < next.length && same < previous.length && sig(next[same]) === sig(previous[same])) same++;
  const changed = new Set(added.map((k) => now.get(k) + 1));
  return { added: added.length, removed: removed.length, changedSteps: [...changed].sort((a, b) => a - b), unchangedBefore: same, total: next.length, was: previous.length };
}

// Parts placed before something under them in their column.
export function violations(model) {
  const parts = model.parts, before = constraints(parts), stepOf = new Map();
  model.steps.forEach((s, n) => s.parts.forEach((k) => stepOf.set(k, n)));
  const bad = [];
  parts.forEach((p, i) => { const n = stepOf.get(p.key); for (const j of before[i]) if (stepOf.get(parts[j].key) > n) { bad.push(p.key); break; } });
  return bad;
}

// Step titles for the manual: the assembly, and which of its steps this is.
export function titles(steps) {
  const count = new Map(), seen = new Map();
  for (const s of steps) if (!s.attach) count.set(s.assembly, (count.get(s.assembly) ?? 0) + 1);
  return steps.map((s) => {
    if (s.attach) return `Attach ${s.assembly || 'subassembly'}`;
    const n = (seen.get(s.assembly) ?? 0) + 1; seen.set(s.assembly, n);
    const name = s.assembly || 'Step';
    return count.get(s.assembly) > 1 ? `${name} · ${n} of ${count.get(s.assembly)}` : name;
  });
}

// Writes each part's assembly onto it (`part.assembly`), so the names stay put
// through edits; structures found from the geometry are numbered in the order
// the manual builds them. Returns the model.
export function assign(model) {
  const names = assemblies(model);
  model.parts.forEach((p, i) => { p.assembly = names[i]; });
  // (numbering by build order needs the plan: only when there is something to number)
  if (!names.some((n) => /^Building \d+$/.test(n ?? ''))) return model;
  const seen = new Map();
  for (const st of plan(model)) if (/^Building \d+$/.test(st.assembly) && !seen.has(st.assembly)) seen.set(st.assembly, `Building ${seen.size + 1}`);
  for (const p of model.parts) if (seen.has(p.assembly)) p.assembly = seen.get(p.assembly);
  return model;
}
