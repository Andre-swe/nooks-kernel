// The instructions checker: scores a manual against the checklist in docs/INSTRUCTIONS.md, so a person sees what to
// fix and an agent can iterate (MCP check_instructions). Pure: no DOM, same answer for the same model.
//
// Six checks, each with a weight, a score from 0 to 1 and its problems (each names its step and parts by key):
//   size        steps neither too big nor too small, and about as many as a real manual of that size has
//   hidden      no new part hidden in its own step's picture (by the step's other parts or by what is built)
//   repeats     a sub-assembly built more than once is shown once, "×N"
//   camera      the camera stays put, and the turn icon shows wherever the view turns
//   bom         every part in exactly one step and in the parts list, and a parts list page
//   buildable   each step builds on the steps before it: nothing before what holds it, nothing left in the air
// The picture test draws each part as its box (orthographic, from the step's view): exact for bricks and plates,
// rough for slopes, round parts and figures. What it does not judge is listed in NOT_VERIFIED.
import { budget, violations } from './planner.mjs';
import { linkIndex } from './edit.mjs';
import { views, repeats, printed, bom, documentOf, editInstructions, inPicture } from './instructions.mjs';
import { insertionFindings } from './insertion.mjs';

export const WEIGHTS = { size: 20, hidden: 20, repeats: 10, camera: 15, bom: 15, buildable: 20 };
export const NOT_VERIFIED = [
  'Whether the pictures read clearly to a builder (colours that look alike, small parts at the edge of a picture).',
  'Whether parts are easy to press on by hand in that order (reaching between walls, clutch strength).',
  'Slopes, round parts and figures are drawn as their boxes in the hidden-part test.',
];
const STUD = 8, PLATE = 3.2;

// The box a part takes up, in mm: [x0, y0, z0, x1, y1, z1] (lib/mass.mjs's rule).
function boxOf(p) {
  if (p.origin && p.extent) { const e = p.extent; return [(p.x + e[0]) * STUD, (p.y + e[1]) * PLATE, (p.z + e[2]) * STUD, (p.x + e[3]) * STUD, (p.y + e[4]) * PLATE, (p.z + e[5]) * STUD]; }
  if (p.origin || !(p.w > 0 && p.d > 0 && p.h > 0)) return [(p.x - 0.5) * STUD, (p.y - 4) * PLATE, (p.z - 0.5) * STUD, (p.x + 0.5) * STUD, p.y * PLATE, (p.z + 0.5) * STUD];
  const turned = p.rotation === 90 || p.rotation === 270, fx = turned ? p.d : p.w, fz = turned ? p.w : p.d;
  return [(p.x - fx / 2) * STUD, p.y * PLATE, (p.z - fz / 2) * STUD, (p.x + fx / 2) * STUD, (p.y + p.h) * PLATE, (p.z + fz / 2) * STUD];
}

// How much of each of `fresh` shows when `all` are drawn from (az, el): a little orthographic z-buffer of boxes.
// → Map key → { area, seen } in pixels.
export function visibility(parts, freshKeys, { az, el }, size = 96) {
  const ra = (az * Math.PI) / 180, re = (el * Math.PI) / 180;
  const d = [Math.cos(re) * Math.sin(ra), Math.sin(re), Math.cos(re) * Math.cos(ra)], r = [Math.cos(ra), 0, -Math.sin(ra)];
  const u = [d[1] * r[2] - d[2] * r[1], d[2] * r[0] - d[0] * r[2], d[0] * r[1] - d[1] * r[0]];
  const boxes = parts.map(boxOf), corners = boxes.map((b) => [0, 1, 2, 3, 4, 5, 6, 7].map((m) => {
    const x = m & 1 ? b[3] : b[0], y = m & 2 ? b[4] : b[1], z = m & 4 ? b[5] : b[2];
    return [x * r[0] + y * r[1] + z * r[2], -(x * u[0] + y * u[1] + z * u[2]), -(x * d[0] + y * d[1] + z * d[2])];
  }));
  // Framed on the new parts (what is looked at); only what can cover them is drawn.
  const fresh = new Set(freshKeys), flat = corners.map((c) => { let a = Infinity, b = -Infinity, e = Infinity, f = -Infinity; for (const q of c) { a = Math.min(a, q[0]); b = Math.max(b, q[0]); e = Math.min(e, q[1]); f = Math.max(f, q[1]); } return [a, b, e, f]; });
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  parts.forEach((p, i) => { if (!fresh.has(p.key)) return; const b = flat[i]; x0 = Math.min(x0, b[0]); x1 = Math.max(x1, b[1]); y0 = Math.min(y0, b[2]); y1 = Math.max(y1, b[3]); });
  if (!(x0 <= x1)) return new Map();
  const span = Math.max(x1 - x0, y1 - y0, 1e-6), k = (size - 1) / span, W = Math.ceil((x1 - x0) * k) + 1, H = Math.ceil((y1 - y0) * k) + 1;
  const depth = new Float32Array(W * H).fill(Infinity), owner = new Int32Array(W * H).fill(-1), stamp = new Int32Array(W * H).fill(-1);
  const area = new Map();
  const FACES = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]];
  corners.forEach((c, idx) => {
    const fb = flat[idx];
    if (fb[1] < x0 || fb[0] > x1 || fb[3] < y0 || fb[2] > y1) return;
    const P = c.map((q) => [(q[0] - x0) * k, (q[1] - y0) * k, q[2]]), mine = fresh.has(parts[idx].key);
    let cover = 0;
    for (const f of FACES) for (const [a, b, e] of [[f[0], f[1], f[2]], [f[0], f[2], f[3]]]) {
      const A = P[a], B = P[b], C = P[e], ar = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
      if (Math.abs(ar) < 1e-9) continue;
      const lx = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]))), hx = Math.min(W - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
      const ly = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]))), hy = Math.min(H - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
      for (let y = ly; y <= hy; y++) for (let x = lx; x <= hx; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((B[0] - px) * (C[1] - py) - (B[1] - py) * (C[0] - px)) / ar, w1 = ((C[0] - px) * (A[1] - py) - (C[1] - py) * (A[0] - px)) / ar, w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const i = y * W + x, z = w0 * A[2] + w1 * B[2] + w2 * C[2];
        if (mine && stamp[i] !== idx) { stamp[i] = idx; cover++; }
        // (a touching face of the part behind loses: nearer by a hair wins)
        if (z < depth[i] - 0.05) { depth[i] = z; owner[i] = idx; }
      }
    }
    if (mine) area.set(idx, cover);
  });
  const seen = new Map();
  for (const o of owner) if (o >= 0 && area.has(o)) seen.set(o, (seen.get(o) ?? 0) + 1);
  const out = new Map();
  for (const [idx, a] of area) out.set(parts[idx].key, { area: a, seen: seen.get(idx) ?? 0 });
  return out;
}

// The checks. `links`: what holds what (lib/graph.mjs connection graph, or anything with links(part)); without it
// the workbench's own index (studs, figures by touch, parts on their side face to face). `maxPictures`: how many
// step pictures the hidden-part test draws on a big manual (spread evenly; it says so when it samples).
export function checkInstructions(model, { links = null, maxPictures = 120 } = {}) {
  const steps = model.steps ?? [], parts = model.parts ?? [], byKey = new Map(parts.map((p) => [p.key, p]));
  const doc = documentOf(model), v = views(model), shown = printed(model);
  const checks = {};
  const insertion = insertionFindings(model);
  const issue = (step, text, keys = []) => ({ ...(step ? { step } : {}), text, ...(keys.length ? { keys: keys.slice(0, 40) } : {}) });

  // ---- size
  {
    const B = budget(parts.length), out = [];
    const real = steps.filter((s) => !s.attach);
    steps.forEach((s, i) => {
      if (s.attach) return;
      const flat = s.parts.length >= 16 && s.parts.every((k) => byKey.get(k)?.h === 1);
      const cap = Math.ceil((flat ? B.flat : B.max) * 1.25);
      if (s.parts.length > cap) out.push(issue(i + 1, `Step ${i + 1} adds ${s.parts.length} parts; a step of this manual takes up to about ${cap}. Split it.`));
      if (s.parts.length === 0) out.push(issue(i + 1, `Step ${i + 1} adds nothing.`));
    });
    // A run of tiny steps in one assembly that would make one ordinary step.
    const tiny = Math.max(1, Math.floor(B.min / 3));
    for (let i = 1; i < steps.length; i++) {
      const a = steps[i - 1], b = steps[i];
      if (a.attach || b.attach || a.assembly !== b.assembly || !!a.aside !== !!b.aside) continue;
      if (a.parts.length <= tiny && b.parts.length <= tiny && a.parts.length + b.parts.length <= B.target && !b.big && !a.big) out.push(issue(i + 1, `Steps ${i} and ${i + 1} add ${a.parts.length} and ${b.parts.length} parts: one step would do.`));
    }
    if (real.length > B.steps * 1.8 && parts.length > 20) out.push(issue(null, `${real.length} steps for ${parts.length} parts: a manual of this size has about ${B.steps}. Merge small steps.`));
    if (real.length < B.steps * 0.4 && parts.length > 20) out.push(issue(null, `${real.length} steps for ${parts.length} parts: a manual of this size has about ${B.steps}. Split big steps.`));
    checks.size = { title: 'Steps the right size', issues: out, score: 1 - Math.min(1, (out.length / Math.max(1, real.length)) * 3) };
  }

  // ---- hidden
  {
    const pic = inPicture(model), out = [];
    const idx = steps.map((s, i) => i).filter((i) => !steps[i].attach && !shown[i].skip && steps[i].parts.length);
    const every = idx.length > maxPictures ? idx.length / maxPictures : 1, sample = [];
    for (let t = 0; t < idx.length; t += every) sample.push(idx[Math.floor(t)]);
    let hiddenCount = 0, looked = 0;
    for (const i of sample) {
      const keys = pic(i), list = keys.map((k) => byKey.get(k)).filter(Boolean);
      const fresh = steps[i].parts.filter((k) => byKey.has(k) && !byKey.get(k).origin);
      if (!fresh.length) continue;
      const seen = visibility(list, fresh, v[i]);
      const hid = [];
      for (const [k, s] of seen) { looked++; if (s.area >= 3 && s.seen / s.area < 0.12) hid.push(k); }
      if (hid.length) {
        hiddenCount += hid.length;
        const fraction = (map) => hid.reduce((sum, k) => { const s = map.get(k); return sum + (s?.area ? s.seen / s.area : 0); }, 0) / hid.length;
        let best = fraction(seen), suggested = null;
        for (const az of [45, 135, 225, 315]) {
          const candidate = { az, el: v[i].el }, score = fraction(visibility(list, hid, candidate));
          if (score > best + 0.2) { best = score; suggested = candidate; }
        }
        out.push({ ...issue(i + 1, `${hid.length} new part${hid.length > 1 ? 's are' : ' is'} hidden in step ${i + 1}'s picture: turn the camera (view) or split the step so they show before what covers them.`, hid), ...(suggested ? { fix: { op:'view', step:i+1, ...suggested } } : {}) });
      }
    }
    checks.hidden = { title: 'New parts can be seen', issues: out, score: 1 - Math.min(1, (hiddenCount / Math.max(1, looked)) * 5), ...(every > 1 ? { sampled: `${sample.length} of ${idx.length} step pictures looked at` } : {}) };
  }

  // ---- repeats
  {
    const groups = repeats(model), out = [];
    for (const g of groups) if (!g.aside) out.push(issue(null, `${g.assemblies.join(', ')} are built the same way ${g.assemblies.length} times: make one a sub-assembly built on the side, shown once ×${g.assemblies.length}.`));
    checks.repeats = { title: 'Repeats shown once, ×N', issues: out, score: groups.length ? 1 - out.length / groups.length : 1, ...(groups.length ? { found: groups.map((g) => ({ assemblies: g.assemblies, times: g.assemblies.length, shownOnce: g.aside })) } : {}) };
  }

  // ---- camera
  {
    const out = [];
    let turns = 0;
    v.forEach((x, i) => {
      if (!x.turned) return;
      turns++;
      if (!x.icon) out.push(issue(i + 1, `The view turns at step ${i + 1} without the turn icon.`));
    });
    const allowed = Math.max(2, Math.ceil(steps.length / 6));
    if (turns > allowed) out.push(issue(null, `The view turns ${turns} times in ${steps.length} steps: keep one camera for a run of steps (about one turn every six steps at most).`));
    checks.camera = { title: 'A steady camera, turns marked', issues: out, score: 1 - Math.min(1, out.length * 0.25 + Math.max(0, turns - allowed) * 0.05), turns };
  }

  // ---- bom
  {
    const out = [], count = new Map();
    for (const s of steps) for (const k of s.parts) count.set(k, (count.get(k) ?? 0) + 1);
    const missing = parts.filter((p) => !count.has(p.key)).map((p) => p.key), twice = [...count].filter(([, n]) => n > 1).map(([k]) => k), stray = [...count.keys()].filter((k) => !byKey.has(k));
    if (missing.length) out.push(issue(null, `${missing.length} part${missing.length > 1 ? 's are' : ' is'} in no step.`, missing));
    if (twice.length) out.push(issue(null, `${twice.length} part${twice.length > 1 ? 's are' : ' is'} in more than one step.`, twice));
    if (stray.length) out.push(issue(null, `${stray.length} step entr${stray.length > 1 ? 'ies name parts' : 'y names a part'} the model does not have.`, stray));
    const lots = bom(model), total = lots.reduce((n, l) => n + l.count, 0);
    if (total !== parts.length) out.push(issue(null, 'The parts list does not add up to the model.'));
    if (Array.isArray(model.inventory) && model.inventory.length) {
      const inv = new Map(model.inventory.map((l) => [`${l.id}|${l.color}`, l.quantity]));
      const off = lots.filter((l) => inv.get(`${l.id}|${l.color}`) !== l.count);
      if (off.length) out.push(issue(null, `${off.length} lot${off.length > 1 ? 's' : ''} in the saved inventory differ from the parts (rebuild the parts list).`));
    }
    if (!doc.bom.show) out.push(issue(null, 'The parts list page is turned off.'));
    checks.bom = { title: 'Every part listed', issues: out, score: Math.max(0, 1 - out.length * 0.34) };
  }

  // ---- buildable
  {
    const out = [], early = violations(model);
    if (early.length) out.push(issue(null, `${early.length} part${early.length > 1 ? 's come' : ' comes'} before what holds ${early.length > 1 ? 'them' : 'it'}.`, early));
    for (const f of insertion.findings) out.push({ ...issue(f.step, `Step ${f.step}: ${f.key}'s estimated insertion path is blocked by ${f.obstruction}.`, [f.key, f.obstruction]), kind: 'blocked-insertion', obstruction: f.obstruction, direction: f.direction });
    if (insertion.status === 'incomplete') out.push(issue(null, 'Insertion-path check is incomplete; some paths could not be assessed.'));
    const index = links ?? linkIndex(model), loose = new Set(model.validation?.floating ?? []);
    let floor = Infinity;
    for (const p of parts) if (!p.origin && p.y < floor) floor = p.y;
    const built = new Map(), first = new Set(), stepOf = new Map();
    steps.forEach((s, i) => s.parts.forEach((k) => stepOf.set(k, i + 1)));
    let floating = 0;
    steps.forEach((s, i) => {
      const line = s.aside ? `aside:${s.assembly}` : 'main';
      if (!built.has(line)) { built.set(line, new Set()); first.add(i); }
      const have = built.get(line);
      if (s.attach) {
        const sub = built.get(`aside:${s.assembly}`) ?? new Set(), main = built.get('main') ?? new Set();
        built.set('main', main);
        const joins = !main.size || [...sub].some((p) => [...index.links(p)].some((q) => main.has(q)));
        if (!joins && sub.size) out.push(issue(i + 1, `Step ${i + 1} attaches ${s.assembly}, but it touches nothing built yet.`));
        for (const p of sub) main.add(p);
        return;
      }
      const list = s.parts.map((k) => byKey.get(k)).filter(Boolean), ok = new Set();
      const grounded = (p) => first.has(i) || (line === 'main' && p.y === floor && !p.origin) || loose.has(p.key);
      let grew = true;
      while (grew) {
        grew = false;
        for (const p of list) if (!ok.has(p) && (grounded(p) || [...index.links(p)].some((q) => have.has(q) || ok.has(q)))) { ok.add(p); grew = true; }
      }
      const left = list.filter((p) => !ok.has(p));
      if (left.length) {
        floating += left.length;
        // Where each could go: the first step after this one that builds a part it holds onto.
        const later = left.map((p) => Math.min(...[...index.links(p)].map((q) => stepOf.get(q.key) ?? Infinity).filter((n) => n > i + 1))).filter(Number.isFinite);
        const to = later.length ? Math.max(...later) : null;
        out.push({ ...issue(i + 1, `${left.length} part${left.length > 1 ? 's' : ''} in step ${i + 1} ${left.length > 1 ? 'hold' : 'holds'} onto nothing built yet${to ? `: what holds ${left.length > 1 ? 'them' : 'it'} comes in step ${to}, so move ${left.length > 1 ? 'them' : 'it'} there` : ''}.`, left.map((p) => p.key)), ...(to ? { fix: { op: 'move', keys: left.map((p) => p.key).slice(0, 40), to } } : {}) });
      }
      for (const p of list) have.add(p);
    });
    checks.buildable = { title: 'Each step builds on the last', issues: out, score: 1 - Math.min(1, ((early.length + floating + insertion.findings.length + (insertion.status === 'incomplete' ? 1 : 0)) / Math.max(1, parts.length)) * 10), insertion };
  }

  for (const [id, c] of Object.entries(checks)) { c.id = id; c.weight = WEIGHTS[id]; c.pass = !c.issues.length; c.score = +Math.max(0, c.score).toFixed(3); }
  const score = Math.round(Object.values(checks).reduce((n, c) => n + c.score * c.weight, 0));
  const failing = Object.values(checks).filter((c) => !c.pass);
  return {
    score, grade: insertion.status !== 'clear' ? 'needs work' : score >= 90 ? 'ready to print' : score >= 75 ? 'nearly there' : score >= 50 ? 'needs work' : 'not ready',
    steps: steps.length, pieces: parts.length,
    checks: Object.values(checks).map(({ id, title, weight, score: s, pass, issues, ...rest }) => ({ id, title, weight, score: s, pass, issues, ...rest })),
    summary: failing.length ? `${score}/100 · fix: ${failing.map((c) => `${c.title.toLowerCase()} (${c.issues.length})`).join(', ')}` : `${score}/100 · every check passes`,
    notVerified: NOT_VERIFIED,
  };
}

// Parts left in the air moved to the step of what holds them (each move kept only where the planner's rule allows),
// pass after pass until nothing more moves. → { model, moved: parts moved, results }
export function repairOrder(model, { links = null, by = 'person', passes = 8 } = {}) {
  let m = model, moved = 0;
  for (let k = 0; k < passes; k++) {
    const fixes = checkInstructions(m, { links, maxPictures: 0 }).checks.find((c) => c.id === 'buildable').issues.filter((i) => i.fix);
    if (!fixes.length) break;
    // Latest first, so earlier step numbers stay put while later ones move.
    const r = editInstructions(m, fixes.sort((a, b) => b.step - a.step).map((i) => i.fix), { by });
    const done = r.results.filter((x) => x.ok).length;
    if (!done) break;
    moved += fixes.filter((_, i) => r.results[i].ok).reduce((n, f) => n + f.fix.keys.length, 0);
    m = r.model;
  }
  return { model: m, moved };
}
