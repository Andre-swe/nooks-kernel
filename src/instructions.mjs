// Building instructions as a document: what a person or an agent edits on top of the planner's steps
// (lib/planner.mjs) and the hand edits that keep its rule (lib/manual.mjs). Pure: no DOM, no clock.
//
// The steps stay where they always were, on `model.steps` (the workbench, the booklet, LDraw export and the server
// all read them). A step may also carry:
//   view: { az, el, zoom? }   the camera for its picture, in degrees (az from the front, turning towards the right;
//                             el above the table). A step without one keeps the view of the step before it, so the
//                             camera stays put unless someone turns it.
//   rotateIcon: false         no turn-the-model icon where the view turns (shown by default)
//   notes: [{ text, x?, y? }] a line of text on its panel (x, y: % of the panel; left out, under the picture)
//   arrows: [{ key, dir }]    an arrow onto part `key`: dir is where it moves, as seen (down, up, left, right)
//   pageBreak, big            a new page starts here; a page of its own (manual.mjs setStepLayout)
// and `model.instructions` holds the rest of the document:
//   { version, page: { size, orientation, perPage }, cover: { show, title, subtitle }, bom: { show },
//     highlight, madeBy: 'planner' | 'person' | 'agent' | 'person and agent', history: [{ by, what }] }
// Instructions travel with the model, so a saved version of a build keeps its instructions and a published set
// shows them (docs/INSTRUCTIONS.md).
import { plan, violations, titles } from './planner.mjs';
import { renameAssembly, splitStep, mergeSteps, moveParts, setStepLayout } from './manual.mjs';

export const VERSION = 1;
export const PAGE_SIZES = { a4: [297, 210], letter: [279.4, 215.9], square: [250, 250] };
export const PER_PAGE = [0, 1, 2, 3, 4, 6, 8];               // 0: automatic
// A display-only ordering for incomplete manuals. Never replace the saved
// steps with this projection: the user must explicitly reconcile them.
export function instructionDisplayModel(model) {
  const valid = new Set(model.parts.map(p => p.key)), seen = new Set();
  let changed = valid.size !== model.parts.length;
  const steps = (model.steps ?? []).map(s => ({ ...s, parts: s.parts.filter(k => {
    if (!valid.has(k) || seen.has(k)) { changed = true; return false; }
    seen.add(k); return true;
  }) }));
  const missing = model.parts.map(p => p.key).filter(k => !seen.has(k));
  if (missing.length) { changed = true; steps.push({ parts: missing, assembly: 'Pieces to review', added: true }); }
  return changed ? { ...model, steps } : model;
}
// A rebuilt model can retain an authored manual only when every old key still
// identifies the same physical piece. Otherwise the caller must refuse the
// build rather than attach annotations to unrelated pieces.
export function carryAuthoredInstructions(previous, next) {
  const authored = previous.instructions?.madeBy && previous.instructions.madeBy !== 'planner' || (previous.steps ?? []).some(s => s.edited || s.view || s.notes?.length || s.arrows?.length || s.pinned || s.pageBreak || s.big);
  if (!authored) return { ok: true, model: next, carried: false };
  const byKey = new Map(next.parts.map(p => [p.key, p]));
  const signature = p => JSON.stringify([p.id, p.color, p.x, p.y, p.z, p.w, p.d, p.h, p.rotation ?? 0, p.ldMatrix ?? null, p.origin ?? null, p.extent ?? null]);
  if (byKey.size !== next.parts.length || new Set(previous.parts.map(p => p.key)).size !== previous.parts.length || previous.parts.some(p => !byKey.has(p.key) || signature(p) !== signature(byKey.get(p.key)))) return { ok: false, reason: 'The build changes or removes pieces in an authored manual, so their instruction references cannot be preserved safely. Edit the existing project in the workbench or start a separate project.' };
  const assemblies = new Map(previous.parts.map(p => [p.key, p.assembly]));
  const { instructions: _generatedInstructions, ...rebuilt } = next;
  const model = { ...rebuilt, parts: next.parts.map(p => assemblies.has(p.key) ? { ...p, assembly: assemblies.get(p.key) } : p), steps: structuredClone(previous.steps ?? []), ...(previous.instructions === undefined ? {} : { instructions: structuredClone(previous.instructions) }) };
  return { ok: true, model, carried: true, needsReview: instructionDisplayModel(model) !== model };
}
// A short card keeps the step picture usable; larger lists get a complete
// derived continuation page without changing the saved step or page settings.
export const STEP_LOTS_PER_PAGE = 48;
export function instructionGrid(k, w, h) {
  let best = [1, k], score = Infinity;
  for (let cols = 1; cols <= k; cols++) {
    const rows = Math.ceil(k / cols), a = (w / cols) / (h / rows), s = Math.abs(Math.log(a / (4 / 3))) + (rows * cols - k) * 0.15;
    if (s < score) { score = s; best = [cols, rows]; }
  }
  return best;
}
// Reserve room for one warning per panel, so pagination and drawing use the
// same capacity regardless of whether the geometric check finds a warning.
export function stepPageGeometry(model, page) {
  const [w, h] = pageSize(documentOf(model)), top = 16, strip = 4 + page.steps.length * 4;
  const area = { x: 10, y: top, w: w - 20, h: h - top - 14 - strip };
  const [cols, rows] = instructionGrid(page.steps.length, area.w, area.h);
  const pw = (area.w - 5 * (cols - 1)) / cols, ph = (area.h - 5 * (rows - 1)) / rows;
  const cell = Math.max(8, Math.min(15, Math.min(pw, ph) * 0.14));
  const across = Math.max(1, Math.floor((pw - 10) / cell));
  const rowsOfLots = Math.max(1, Math.floor((ph * 0.4 - 8) / (cell + 3)));
  return { area, cols, rows, pw, ph, cell, across, capacity: across * rowsOfLots };
}
export const ARROWS = ['down', 'up', 'left', 'right'];
// A turn of this much between two steps' views (degrees) is a turn of the model: the page shows the rotate icon.
export const TURN_AZ = 40, TURN_EL = 25;
const HISTORY = 60;

const num = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : d);
const str = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const wrapAz = (a) => ((Math.round(a) % 360) + 540) % 360 - 180;

// The document with every default filled in (never mutates the model).
export function documentOf(model) {
  const d = model?.instructions && typeof model.instructions === 'object' ? model.instructions : {};
  const page = d.page ?? {};
  return {
    version: VERSION,
    page: { size: Object.hasOwn(PAGE_SIZES, page.size) ? page.size : 'a4', orientation: page.orientation === 'portrait' ? 'portrait' : 'landscape', perPage: PER_PAGE.includes(page.perPage) ? page.perPage : 0 },
    cover: { show: d.cover?.show !== false, title: str(d.cover?.title, 80), subtitle: str(d.cover?.subtitle, 120) },
    bom: { show: d.bom?.show !== false },
    highlight: d.highlight !== false,
    madeBy: ['planner', 'person', 'agent', 'person and agent'].includes(d.madeBy) ? d.madeBy : 'planner',
    history: Array.isArray(d.history) ? d.history.slice(-HISTORY) : [],
  };
}

// Page size in mm, as [width, height].
export function pageSize(doc) {
  const [a, b] = PAGE_SIZES[doc.page.size];
  return doc.page.orientation === 'portrait' ? [Math.min(a, b), Math.max(a, b)] : [Math.max(a, b), Math.min(a, b)];
}

// The view a manual starts from: three-quarters from the front, onto a long model's long side (as viewer.mjs frames
// its manual pictures).
export function defaultView(model) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of model.parts ?? []) {
    const turned = p.rotation === 90 || p.rotation === 270, fx = turned ? p.d : p.w, fz = turned ? p.w : p.d;
    x0 = Math.min(x0, p.x - fx / 2); x1 = Math.max(x1, p.x + fx / 2); z0 = Math.min(z0, p.z - fz / 2); z1 = Math.max(z1, p.z + fz / 2);
  }
  const sx = x1 - x0, sz = z1 - z0;
  if (sx > sz * 1.4) return { az: 16, el: 24 };
  if (sz > sx * 1.4) return { az: 106, el: 24 };
  return { az: 35, el: 20 };
}

const turnBetween = (a, b) => Math.abs(wrapAz(a.az - b.az)) >= TURN_AZ || Math.abs(a.el - b.el) >= TURN_EL;

// Each step's camera: its own view or the one before it in the same line of building (the main build, or one
// sub-assembly built on the side), and whether the model turns there. → [{ az, el, zoom, own, turned, icon, flipped }]
export function views(model) {
  const start = defaultView(model), last = new Map(), out = [];
  for (const st of model.steps ?? []) {
    const line = st.aside ? `aside:${st.assembly}` : 'main';
    const prev = last.get(line) ?? (st.aside ? null : start);
    const own = st.view && Number.isFinite(st.view.az) && Number.isFinite(st.view.el);
    const v = own ? { az: wrapAz(st.view.az), el: num(st.view.el, -89, 89, 20), zoom: num(st.view.zoom, 0.4, 3, 1) } : prev ? { ...prev } : { ...start, zoom: 1 };
    v.zoom ??= 1;
    const turned = !!(prev && turnBetween(prev, v));
    out.push({ ...v, own: !!own, turned, icon: turned && st.rotateIcon !== false, flipped: v.el < 0 });
    last.set(line, { az: v.az, el: v.el, zoom: v.zoom });
  }
  return out;
}

// An assembly's shape, wherever it stands: its parts relative to its lowest corner, in one of four quarter turns
// (the smallest of the four, so a copy turned round still matches).
function signature(parts) {
  const turnPt = (p, k) => { let x = p.x, z = p.z; for (let i = 0; i < k; i++) [x, z] = [-z, x]; return [x, z]; };
  let best = null;
  for (let k = 0; k < 4; k++) {
    const pts = parts.map((p) => { const [x, z] = turnPt(p, k); return { x, z, y: p.y, id: p.id, c: p.color, r: p.ldMatrix ? 'm' : (((p.rotation ?? 0) + 90 * k) % 180) }; });
    const mx = Math.min(...pts.map((q) => q.x)), my = Math.min(...pts.map((q) => q.y)), mz = Math.min(...pts.map((q) => q.z));
    const s = pts.map((q) => `${q.id}|${q.c}|${q.r}|${+(q.x - mx).toFixed(2)}|${+(q.y - my).toFixed(2)}|${+(q.z - mz).toFixed(2)}`).sort().join(';');
    if (best === null || s < best) best = s;
  }
  return best;
}

// Assemblies built more than once: the same parts in the same shape. Sub-builds (connector plan, piece 2) are read
// from the parts' `subBuild` when a model has them: copies of one definition are repeats by definition.
// → [{ assemblies: [name…] (in build order), aside: every copy built on the side, parts: per copy }]
export function repeats(model) {
  const parts = model.parts ?? [], byName = new Map(), order = [];
  for (const st of model.steps ?? []) if (st.assembly && !order.includes(st.assembly)) order.push(st.assembly);
  for (const p of parts) { const a = p.assembly; if (a == null) continue; if (!byName.has(a)) byName.set(a, []); byName.get(a).push(p); }
  const aside = new Set((model.steps ?? []).filter((s) => s.aside).map((s) => s.assembly));
  const groups = new Map();
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    const defs = new Set(list.map((p) => p.subBuild ?? null));
    const key = defs.size === 1 && [...defs][0] ? `def:${[...defs][0]}:${list.length}` : signature(list);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(name);
  }
  return [...groups.values()].filter((g) => g.length > 1)
    .map((g) => g.sort((a, b) => order.indexOf(a) - order.indexOf(b)))
    .map((g) => ({ assemblies: g, aside: g.every((a) => aside.has(a)), parts: byName.get(g[0]).length }));
}

// The steps as printed: a sub-assembly built more than once is shown once with "×N" on its steps, and its copies'
// own building steps are left out (their attach steps stay). → [{ n, times, skip, sameAs }]
export function printed(model) {
  const steps = model.steps ?? [], out = steps.map((_, i) => ({ n: i + 1, times: 1, skip: false, sameAs: null }));
  for (const r of repeats(model)) {
    if (!r.aside) continue;
    const [first, ...copies] = r.assemblies;
    steps.forEach((s, i) => {
      if (s.attach) return;
      if (s.assembly === first) out[i].times = r.assemblies.length;
      if (copies.includes(s.assembly)) { out[i].skip = true; out[i].sameAs = first; }
    });
  }
  return out;
}

const WEIGHT = (s) => (s.big ? 4 : s.attach ? 2 : s.parts.length >= 24 ? 4 : s.parts.length >= 10 ? 2 : 1);

// The pages: a cover, the steps (several to a page as a manual has them), the parts list. Automatic: up to four
// small steps a page, a big one on its own, a new page where a section of more than one step starts; a fixed count
// puts that many on each page. A page break or an own page is always kept.
// → [{ kind: 'cover' } | { kind: 'steps', steps: [n…], sections: [name…] } | { kind: 'bom', from, to }]
export function pages(model, { bomPerPage = 48 } = {}) {
  const doc = documentOf(model), steps = model.steps ?? [], shown = printed(model), out = [];
  if (doc.cover.show) out.push({ kind: 'cover' });
  const count = new Map();
  for (const s of steps) count.set(s.assembly, (count.get(s.assembly) ?? 0) + 1);
  const per = doc.page.perPage;
  let cur = null, used = 0, prev = null;
  steps.forEach((s, i) => {
    if (shown[i].skip) return;
    const w = per ? 1 : WEIGHT(s), cap = per || 4;
    const fresh = !per && prev && s.assembly !== prev.assembly && (count.get(s.assembly) > 1 || s.aside);
    if (!cur || used + w > cap || fresh || s.pageBreak || s.big || cur.big) { cur = { kind: 'steps', steps: [], sections: [], big: !!s.big }; out.push(cur); used = 0; }
    cur.steps.push(i + 1); used += w;
    if (s.assembly && !cur.sections.includes(s.assembly)) cur.sections.push(s.assembly);
    prev = s;
  });
  for (const p of out) delete p.big;
  // Put a step's full list immediately after its step page. The first few lots
  // remain on the panel as a preview; continuation pages repeat all lots so the
  // builder can use a single complete list.
  const withParts = [];
  for (const p of out) {
    withParts.push(p);
    if (p.kind !== 'steps') continue;
    for (const n of p.steps) {
      const lots = steps[n - 1].attach ? [] : stepParts(model, n);
      if (lots.length <= stepPageGeometry(model, p).capacity) continue;
      for (let from = 0; from < lots.length; from += STEP_LOTS_PER_PAGE)
        withParts.push({ kind: 'step-parts', step: n, from, to: Math.min(lots.length, from + STEP_LOTS_PER_PAGE) });
    }
  }
  out.splice(0, out.length, ...withParts);
  if (doc.bom.show) {
    const lots = bom(model).length;
    for (let from = 0; from < Math.max(1, lots); from += bomPerPage) out.push({ kind: 'bom', from, to: Math.min(lots, from + bomPerPage) });
  }
  return out;
}

// Which parts are in step n's picture: a main step shows the main build and every sub-assembly attached by then; a
// step built on the side shows only its own assembly so far.
export function inPicture(model) {
  const steps = model.steps, attachAt = new Map();
  steps.forEach((s, i) => { if (s.attach) attachAt.set(s.assembly, i); });
  // (`n` from 0) → the keys in that picture.
  return (n) => {
    const st = steps[n], keys = [];
    for (let i = 0; i <= n; i++) {
      const s = steps[i];
      if (st.aside ? s.aside && s.assembly === st.assembly : !s.aside || (attachAt.get(s.assembly) ?? Infinity) <= n) keys.push(...s.parts);
    }
    return keys;
  };
}

// Parts newly presented by step n. Attachment steps usually have no parts of
// their own: their previously built side assembly is what is being attached.
export function stepFresh(model, n) {
  const st = model.steps?.[n - 1];
  if (!st) return [];
  if (!st.attach) return [...st.parts];
  const keys = new Set(st.parts);
  for (const s of model.steps.slice(0, n - 1)) if (s.aside && s.assembly === st.assembly) for (const k of s.parts) keys.add(k);
  return [...keys];
}

// What a step adds: [{ id, color, count }], the most first. A sub-assembly's attach step adds the assembly itself.
export function stepParts(model, n) {
  const st = model.steps?.[n - 1];
  if (!st) return [];
  const byKey = new Map(model.parts.map((p) => [p.key, p])), lots = new Map();
  for (const k of st.parts) {
    const p = byKey.get(k);
    if (!p) continue;
    const id = `${p.id}|${p.color}`;
    lots.set(id, { id: p.id, color: p.color, count: (lots.get(id)?.count ?? 0) + 1 });
  }
  return [...lots.values()].sort((a, b) => b.count - a.count || String(a.id).localeCompare(String(b.id)));
}

// The bill of materials: every part of the model, by design and colour. → [{ id, color, count }]
export function bom(model) {
  const lots = new Map();
  for (const p of model.parts ?? []) { const id = `${p.id}|${p.color}`; lots.set(id, { id: p.id, color: p.color, count: (lots.get(id)?.count ?? 0) + 1 }); }
  return [...lots.values()].sort((a, b) => b.count - a.count || String(a.id).localeCompare(String(b.id)) || a.color - b.color);
}

// ---------------------------------------------------------------- editing
// Changes to the instructions, as data, applied in order: each is checked (the planner's rule: no part before what
// holds it) and refused with a reason, or applied. Nothing in the model changes except its steps, its instructions
// document and, for `subassembly` and `rename`, the parts' assembly names.
//   { op: 'split', step, keys? }            step in two (keys: those go into a new step after it; else the upper half)
//   { op: 'merge', step }                   with the step after it
//   { op: 'move', keys, to, newStep? }      parts into step `to` (newStep: a new step straight after `to`)
//   { op: 'reorder', step, to }             a step to another place
//   { op: 'view', step, az, el, zoom? }     the camera from this step on ({ step, reset: true }: as the step before)
//   { op: 'rotateIcon', step, on }          the turn icon where the view turns
//   { op: 'subassembly', keys, name }       these parts built on the side, then attached ("×N" when it repeats)
//   { op: 'note', step, text, x?, y? }      a note on the step ({ step, clear: true } takes its notes away)
//   { op: 'arrow', step, key, dir }         an arrow onto a part ({ step, clear: true } takes its arrows away)
//   { op: 'page', size?, orientation?, perPage? }
//   { op: 'pageBreak', step, on } · { op: 'big', step, on }
//   { op: 'cover', show?, title?, subtitle? } · { op: 'bom', show } · { op: 'highlight', on }
//   { op: 'rename', from, to }              a section's name
//   { op: 'replan' }                        start again from the planner
// `by`: 'person' or 'agent' (recorded in the document's history and madeBy).
// → { ok, model (a new object: steps, instructions and parts copied where changed), results: [{ op, ok, reason? }] }
export function editInstructions(model, ops, { by = 'person' } = {}) {
  let m = { ...model, steps: (model.steps ?? []).map((s) => ({ ...s, parts: [...s.parts] })), instructions: documentOf(model) };
  let partsCopied = false;
  const ownParts = () => { if (!partsCopied) { m.parts = m.parts.map((p) => ({ ...p })); partsCopied = true; } };
  const results = [], did = [];
  const stepAt = (n) => m.steps[Math.round(n) - 1];
  const accept = (r, what) => { if (!r.ok) return r; m.steps = r.steps; did.push(what); return { ok: true }; };
  for (const op of Array.isArray(ops) ? ops : [ops]) {
    let r;
    try { r = apply(op); } catch (e) { r = { ok: false, reason: String(e?.message ?? e) }; }
    results.push({ op: op?.op ?? null, ok: !!r.ok, ...(r.ok ? {} : { reason: r.reason }) });
  }
  function apply(op) {
    const n = Math.round(+op?.step);
    const need = () => (stepAt(n) ? null : { ok: false, reason: `There is no step ${op?.step}: the manual has ${m.steps.length}.` });
    switch (op?.op) {
      case 'reconcile': {
        const keys = m.parts.map(p => p.key), valid = new Set(keys), seen = new Set();
        if (valid.size !== keys.length || keys.some(k => !Number.isInteger(k))) return { ok: false, reason: 'Part keys must be unique integers before reconciling.' };
        m.steps = m.steps.map(s => ({ ...s, parts: s.parts.filter(k => {
          if (!valid.has(k) || seen.has(k)) return false;
          seen.add(k); return true;
        }) }));
        const missing = keys.filter(k => !seen.has(k));
        if (missing.length) m.steps.push({ parts: missing, assembly: 'Pieces to review', added: true });
        did.push('reconciled piece membership; review the instructions');
        return { ok: true };
      }
      case 'split': {
        if (need()) return need();
        if (Array.isArray(op.keys) && op.keys.length) {
          const st = stepAt(n), keys = new Set(op.keys);
          const out = st.parts.filter((k) => keys.has(k)), stay = st.parts.filter((k) => !keys.has(k));
          if (!out.length || !stay.length) return { ok: false, reason: 'Choose some of the step\'s parts, not none or all of them.' };
          const steps = m.steps.map((s) => ({ ...s, parts: [...s.parts] }));
          steps.splice(n - 1, 1, { ...st, parts: stay, edited: true }, { ...st, parts: out, edited: true, pinned: false, view: undefined, notes: undefined, arrows: undefined, pageBreak: undefined, big: undefined });
          return accept(rule(steps, 'That split puts a part before what holds it'), `split step ${n}`);
        }
        return accept(splitStep(m, n), `split step ${n}`);
      }
      case 'merge': if (need()) return need(); return accept(mergeSteps(m, n), `merged steps ${n} and ${n + 1}`);
      case 'move': {
        const to = Math.round(+op.to), keys = [...new Set(op.keys ?? [])].filter((k) => m.parts.some((p) => p.key === k));
        if (!keys.length) return { ok: false, reason: 'Name the parts to move by key.' };
        if (!stepAt(to)) return { ok: false, reason: `There is no step ${op.to}.` };
        if (op.newStep) {
          const set = new Set(keys), steps = m.steps.map((s) => ({ ...s, parts: s.parts.filter((k) => !set.has(k)) }));
          steps.splice(to, 0, { parts: keys, assembly: stepAt(to).assembly, ...(stepAt(to).aside ? { aside: true } : {}), edited: true });
          return accept(rule(steps.filter((s) => s.parts.length || s.attach), `Those parts cannot come straight after step ${to}`), `moved ${keys.length} part(s) to a new step after ${to}`);
        }
        return accept(moveParts(m, keys, to), `moved ${keys.length} part(s) to step ${to}`);
      }
      case 'reorder': {
        if (need()) return need();
        const to = Math.round(+op.to);
        if (!(to >= 1 && to <= m.steps.length)) return { ok: false, reason: `Step ${op.to} is not in the manual.` };
        const steps = m.steps.map((s) => ({ ...s, parts: [...s.parts] })), [st] = steps.splice(n - 1, 1);
        steps.splice(to - 1, 0, { ...st, edited: true });
        return accept(rule(steps, `Step ${n} cannot go there`), `moved step ${n} to ${to}`);
      }
      case 'view': {
        if (need()) return need();
        const st = stepAt(n);
        if (op.reset) { delete st.view; did.push(`view of step ${n} as before`); return { ok: true }; }
        if (!Number.isFinite(+op.az) || !Number.isFinite(+op.el)) return { ok: false, reason: 'A view needs az and el, in degrees.' };
        st.view = { az: wrapAz(+op.az), el: Math.round(num(op.el, -89, 89, 20)), ...(op.zoom !== undefined ? { zoom: +num(op.zoom, 0.4, 3, 1).toFixed(2) } : {}) };
        did.push(`view of step ${n}`);
        return { ok: true };
      }
      case 'rotateIcon': if (need()) return need(); if (op.on === false) stepAt(n).rotateIcon = false; else delete stepAt(n).rotateIcon; did.push(`turn icon on step ${n}`); return { ok: true };
      case 'note': {
        if (need()) return need();
        const st = stepAt(n);
        if (op.clear) { delete st.notes; did.push(`notes of step ${n} cleared`); return { ok: true }; }
        const text = str(op.text, 140);
        if (!text) return { ok: false, reason: 'A note needs some text.' };
        if ((st.notes ?? []).length >= 4) return { ok: false, reason: 'Four notes a step at most.' };
        st.notes = [...(st.notes ?? []), { text, ...(Number.isFinite(+op.x) && Number.isFinite(+op.y) ? { x: num(op.x, 0, 96, 0), y: num(op.y, 0, 94, 0) } : {}) }];
        did.push(`note on step ${n}`);
        return { ok: true };
      }
      case 'arrow': {
        if (need()) return need();
        const st = stepAt(n);
        if (op.clear) { delete st.arrows; did.push(`arrows of step ${n} cleared`); return { ok: true }; }
        if (!ARROWS.includes(op.dir)) return { ok: false, reason: `An arrow's dir is one of ${ARROWS.join(', ')}.` };
        // An arrow points at a part that is in the picture: one of this step's, or one built before it.
        const upto = new Set(m.steps.slice(0, n).flatMap((s) => s.parts));
        if (!upto.has(op.key)) return { ok: false, reason: `Part ${op.key} is not built by step ${n}.` };
        if ((st.arrows ?? []).length >= 6) return { ok: false, reason: 'Six arrows a step at most.' };
        st.arrows = [...(st.arrows ?? []).filter((a) => a.key !== op.key), { key: op.key, dir: op.dir }];
        did.push(`arrow on step ${n}`);
        return { ok: true };
      }
      case 'subassembly': return subassembly(op);
      case 'page': {
        if (op.size !== undefined && !Object.hasOwn(PAGE_SIZES, op.size)) return { ok: false, reason: 'Unknown page size.' };
        if (op.orientation !== undefined && !['portrait', 'landscape'].includes(op.orientation)) return { ok: false, reason: 'Orientation is portrait or landscape.' };
        if (op.perPage !== undefined && !PER_PAGE.includes(op.perPage)) return { ok: false, reason: 'Unsupported steps per page.' };
        const p = m.instructions.page;
        if (op.size !== undefined) { if (!PAGE_SIZES[op.size]) return { ok: false, reason: `Page size is one of ${Object.keys(PAGE_SIZES).join(', ')}.` }; p.size = op.size; }
        if (op.orientation !== undefined) { if (!['portrait', 'landscape'].includes(op.orientation)) return { ok: false, reason: 'Orientation is portrait or landscape.' }; p.orientation = op.orientation; }
        if (op.perPage !== undefined) { if (!PER_PAGE.includes(op.perPage)) return { ok: false, reason: `Steps a page is one of ${PER_PAGE.join(', ')} (0: automatic).` }; p.perPage = op.perPage; }
        did.push('page layout');
        return { ok: true };
      }
      case 'pageBreak': case 'big': if (need()) return need(); return accept(setStepLayout(m, n, { [op.op]: op.on !== false }), `${op.op === 'big' ? 'own page' : 'page break'} at step ${n}`);
      case 'cover': {
        const c = m.instructions.cover;
        if (op.show !== undefined) c.show = op.show !== false;
        if (op.title !== undefined) c.title = str(op.title, 80);
        if (op.subtitle !== undefined) c.subtitle = str(op.subtitle, 120);
        did.push('cover');
        return { ok: true };
      }
      case 'bom': m.instructions.bom.show = op.show !== false; did.push('parts list'); return { ok: true };
      case 'highlight': m.instructions.highlight = op.on !== false; did.push('new parts highlight'); return { ok: true };
      case 'rename': {
        ownParts();
        const r = renameAssembly(m, op.from, op.to);
        return accept(r, `renamed ${op.from}`);
      }
      case 'replan': { m.steps = plan(m); did.push('planned again'); return { ok: true }; }
      default: return { ok: false, reason: `Unknown op ${op?.op}. Ops: split, merge, move, reorder, view, rotateIcon, subassembly, note, arrow, page, pageBreak, big, cover, bom, highlight, rename, replan.` };
    }
  }
  // Parts built on the side as one sub-assembly, planned on their own and attached in a step after them.
  function subassembly(op) {
    const name = str(op.name, 60), keys = new Set(op.keys ?? []);
    const list = m.parts.filter((p) => keys.has(p.key));
    if (!name) return { ok: false, reason: 'Give the sub-assembly a name.' };
    if (list.length < 2) return { ok: false, reason: 'A sub-assembly needs two parts or more.' };
    if (m.steps.some((s) => s.assembly === name && s.parts.some((k) => !keys.has(k)))) return { ok: false, reason: `There is already a section called ${name}.` };
    const first = m.steps.findIndex((s) => s.parts.some((k) => keys.has(k)));
    const sub = plan({ ...m, parts: list.map((p) => ({ ...p, assembly: name })), steps: [] }).map((s) => ({ ...s, assembly: name, aside: true, edited: true }));
    const rest = m.steps.map((s) => ({ ...s, parts: s.parts.filter((k) => !keys.has(k)) })).filter((s) => s.parts.length || s.attach);
    const at = Math.min(rest.length, m.steps.slice(0, first).filter((s) => s.parts.some((k) => !keys.has(k)) || s.attach).length);
    // Built on the side first, then attached where its first part was.
    const steps = [...rest.slice(0, at), ...sub, { parts: [], assembly: name, attach: true, edited: true }, ...rest.slice(at)];
    const r = rule(steps, 'Those parts cannot be built on the side there');
    if (!r.ok) return r;
    ownParts();
    for (const p of m.parts) if (keys.has(p.key)) p.assembly = name;
    m.steps = steps;
    did.push(`sub-assembly ${name}`);
    return { ok: true };
  }
  // The planner's rule on a whole new list of steps; steps built on the side do not count against their attach.
  function rule(steps, reason) {
    const bad = violations({ ...m, steps });
    return bad.length ? { ok: false, reason: `${reason} (${bad.length} part${bad.length > 1 ? 's' : ''} would come before what holds ${bad.length > 1 ? 'them' : 'it'}).` } : { ok: true, steps };
  }
  if (did.length) {
    const doc = m.instructions, was = doc.madeBy;
    doc.madeBy = was === 'planner' || was === by ? by : 'person and agent';
    doc.history = [...doc.history, { by, what: did.join('; ').slice(0, 300) }].slice(-HISTORY);
  }
  return { ok: results.every((r) => r.ok), model: m, results };
}

// A short reading of the instructions for an agent: steps with their parts, views and page layout, without the
// whole part list. → { document, steps: [...], pages: [...], repeats }
export function summary(model) {
  const names = titles(model.steps ?? []), v = views(model), shown = printed(model), byKey = new Map(model.parts.map((p) => [p.key, p]));
  return {
    document: documentOf(model),
    pieces: model.parts.length,
    steps: (model.steps ?? []).map((s, i) => ({
      step: i + 1, title: names[i], assembly: s.assembly ?? null, ...(s.aside ? { aside: true } : {}), ...(s.attach ? { attach: true } : {}),
      parts: s.parts.map((k) => { const p = byKey.get(k); return p ? { key: k, id: p.id, color: p.color, at: [p.x, p.y, p.z] } : { key: k }; }),
      view: { az: v[i].az, el: v[i].el, own: v[i].own, turned: v[i].turned, icon: v[i].icon },
      ...(shown[i].times > 1 ? { times: shown[i].times } : {}), ...(shown[i].skip ? { shownAs: shown[i].sameAs } : {}),
      ...(s.notes ? { notes: s.notes } : {}), ...(s.arrows ? { arrows: s.arrows } : {}), ...(s.pageBreak ? { pageBreak: true } : {}), ...(s.big ? { big: true } : {}),
    })),
    pages: pages(model).map((p, i) => ({ page: i + 1, ...p })),
    repeats: repeats(model),
  };
}

// Who made these instructions, in words for a page ("" for the planner's own, which says nothing).
export function credit(model) {
  return { person: 'Instructions arranged by the designer', agent: 'Instructions arranged by an agent', 'person and agent': 'Instructions arranged by the designer with an agent' }[documentOf(model).madeBy] ?? '';
}

// The instructions' own fields on steps and the document, kept to what they may hold (a saved model from a page or
// an agent is checked with it; other fields on a step pass through untouched). → { steps, instructions? }
export function cleanInstructions(model) {
  const steps = (model.steps ?? []).map((s) => {
    const out = { ...s };
    if (s.view !== undefined) { if (s.view && Number.isFinite(+s.view.az) && Number.isFinite(+s.view.el)) out.view = { az: wrapAz(+s.view.az), el: Math.round(num(s.view.el, -89, 89, 20)), ...(s.view.zoom !== undefined ? { zoom: +num(s.view.zoom, 0.4, 3, 1).toFixed(2) } : {}) }; else delete out.view; }
    if (s.rotateIcon !== undefined) { if (s.rotateIcon === false) out.rotateIcon = false; else delete out.rotateIcon; }
    if (s.notes !== undefined) { const n = (Array.isArray(s.notes) ? s.notes : []).slice(0, 4).map((x) => ({ text: str(x?.text, 140), ...(Number.isFinite(+x?.x) && Number.isFinite(+x?.y) ? { x: num(x.x, 0, 96, 0), y: num(x.y, 0, 94, 0) } : {}) })).filter((x) => x.text); if (n.length) out.notes = n; else delete out.notes; }
    if (s.arrows !== undefined) { const a = (Array.isArray(s.arrows) ? s.arrows : []).slice(0, 6).filter((x) => Number.isInteger(x?.key) && ARROWS.includes(x?.dir)).map((x) => ({ key: x.key, dir: x.dir })); if (a.length) out.arrows = a; else delete out.arrows; }
    return out;
  });
  return { steps, ...(model.instructions !== undefined ? { instructions: documentOf(model) } : {}) };
}
