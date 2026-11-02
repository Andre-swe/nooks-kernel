// The reviewer: an automatic pass over every finished model and its manual,
// the way a set designer checks a design before it ships. It runs without
// anyone tuning anything: each check finds problems, fixes what it safely
// can, and says what it did. Pure: no DOM, no network; the same model in
// gives the same review out.
//
// Every change is recorded in `model.provenance.review`, with its evidence:
// 'rule' for mechanical fixes (a step order, a colour that is not made) and
// 'interpretation' for judgements (a section's name read from its shape).
// Nothing it adds is presented as observed. An optional model-backed pass
// (api/review.mjs) proposes further edits through the same operations,
// marked 'ai-inference'.
import { violations, plan, budget, titles } from './planner.mjs';
import { isMade, nearestMade } from './availability.mjs';
import { BY_CODE } from './palette.mjs';

export const REVIEWER = { by: 'nooks-reviewer', version: 1 };

const footprint = (p) => (p.rotation === 90 || p.rotation === 270 ? [p.d, p.w] : [p.w, p.d]);

// Each check: (model) → { finding?, fix?() → said }. A fix changes the model
// and returns what it did, in words.
const CHECKS = [
  // The manual: every part in exactly one step, no part before what holds it.
  function order(model) {
    const keys = new Set(model.parts.map((p) => p.key)), seen = new Map();
    for (const s of model.steps) for (const k of s.parts) seen.set(k, (seen.get(k) ?? 0) + 1);
    const missing = [...keys].filter((k) => !seen.has(k)).length, twice = [...seen.values()].filter((n) => n > 1).length;
    const gone = [...seen.keys()].filter((k) => !keys.has(k)).length, bad = violations(model).length;
    if (!missing && !twice && !gone && !bad) return {};
    return {
      finding: `The manual had ${[bad && `${bad} parts before what holds them`, missing && `${missing} parts in no step`, twice && `${twice} in two steps`, gone && `${gone} steps naming parts that are gone`].filter(Boolean).join(', ')}.`,
      evidence: 'rule',
      fix: () => { model.steps = plan(model); return 'Planned the manual again from the model.'; },
    };
  },
  // Steps with nothing in them, and attach steps for sub-builds that are gone.
  function emptySteps(model) {
    const live = new Set(model.steps.filter((s) => s.parts.length).map((s) => s.assembly));
    const dead = model.steps.filter((s) => (!s.parts.length && !s.attach) || (s.attach && !live.has(s.assembly)));
    if (!dead.length) return {};
    return { finding: `${dead.length} empty step${dead.length > 1 ? 's' : ''}.`, evidence: 'rule', fix: () => { model.steps = model.steps.filter((s) => !dead.includes(s)); return `Removed ${dead.length} empty step${dead.length > 1 ? 's' : ''}.`; } };
  },
  // No useless pages: about as many steps as a real manual of that size, and
  // no one-part steps where the part could go with its neighbour.
  function stepCount(model) {
    const B = budget(model.parts.length), target = Math.round(B.steps * 1.15);
    const single = model.steps.filter((s, i) => s.parts.length === 1 && !s.attach && !s.aside && !s.pinned && (model.steps[i - 1]?.assembly === s.assembly || model.steps[i + 1]?.assembly === s.assembly)).length;
    if (model.steps.length <= target && !single) return {};
    return {
      finding: `${model.steps.length} steps${model.steps.length > target ? ` (a manual this size has about ${B.steps})` : ''}${single ? `, ${single} with a single part` : ''}.`,
      evidence: 'rule',
      fix: () => {
        const was = model.steps.length;
        model.steps = squeeze(model.steps, target, B.flat * 1.5);
        return `Merged neighbouring steps of the same section: ${was} → ${model.steps.length} steps.`;
      },
    };
  },
  // Parts in colours they are not made in (a generated design only: a kit's
  // designer chose its parts).
  function colours(model) {
    if (model.provenance?.source?.kind === 'kit') return {};
    const wrong = model.parts.filter((p) => !p.origin && !isMade(p.id, p.color) && nearestMade(p.id, p.color) !== p.color);
    if (!wrong.length) return {};
    return {
      finding: `${wrong.length} part${wrong.length > 1 ? 's' : ''} in a colour that part is not made in.`,
      evidence: 'rule',
      fix: () => { for (const p of wrong) p.color = nearestMade(p.id, p.color); recount(model); return `Recoloured ${wrong.length} part${wrong.length > 1 ? 's' : ''} to the nearest colour they are made in.`; },
    };
  },
  // Floating parts: reported, not hidden (the designer already tried to tie them in).
  function floating(model) {
    const n = model.validation?.floating?.length ?? 0;
    return n ? { finding: `${n} part${n > 1 ? 's' : ''} not held by studs to the rest.` } : {};
  },
  // Tall thin columns: one stud wide and more than three bricks tall with
  // nothing beside them break off in the hand.
  function slender(model) {
    const cols = new Map();
    for (const p of model.parts) {
      const [fx, fz] = footprint(p);
      if (fx !== 1 || fz !== 1 || p.origin) continue;
      const k = `${p.x},${p.z}`;
      if (!cols.has(k)) cols.set(k, []);
      cols.get(k).push(p);
    }
    const occupied = new Set();
    for (const p of model.parts) { const [fx, fz] = footprint(p); for (let i = 0; i < fx; i++) for (let j = 0; j < fz; j++) occupied.add(`${Math.floor(p.x - fx / 2 + i + 1e-6)},${Math.floor(p.z - fz / 2 + j + 1e-6)}`); }
    let thin = 0;
    for (const [k, list] of cols) {
      const [x, z] = k.split(',').map(Number), cx = Math.floor(x), cz = Math.floor(z);
      const height = list.reduce((s, p) => s + p.h, 0);
      const alone = ![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => occupied.has(`${cx + dx},${cz + dz}`));
      if (height > 9 && alone) thin++;
    }
    return thin ? { finding: `${thin} column${thin > 1 ? 's' : ''} one stud wide and over three bricks tall, standing free: fragile.` } : {};
  },
  // Section names: "Building 4" says nothing. A name from its shape, marked
  // as an interpretation (the map's own names, when it has them, win).
  function names(model) {
    const generic = [...new Set(model.parts.map((p) => p.assembly).filter((a) => /^Building \d+$/.test(a ?? '')))];
    if (!generic.length) return {};
    return {
      finding: `${generic.length} section${generic.length > 1 ? 's' : ''} named only by number.`,
      evidence: 'interpretation',
      fix: () => {
        const taken = new Set(model.parts.map((p) => p.assembly)), renamed = [];
        for (const a of generic) {
          const own = model.parts.filter((p) => p.assembly === a);
          let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y1 = 0;
          for (const p of own) { const [fx, fz] = footprint(p); x0 = Math.min(x0, p.x - fx / 2); x1 = Math.max(x1, p.x + fx / 2); z0 = Math.min(z0, p.z - fz / 2); z1 = Math.max(z1, p.z + fz / 2); y1 = Math.max(y1, p.y + p.h); }
          const w = x1 - x0, d = z1 - z0, h = (y1 * 3.2) / 8;            // height in studs
          const kind = h > Math.max(w, d) * 2.5 ? 'Tower' : h > Math.max(w, d) ? 'Tall building' : Math.max(w, d) > Math.min(w, d) * 3 ? 'Long building' : h < 1.5 ? 'Low building' : 'Block';
          let name = kind, n = 2;
          while (taken.has(name)) name = `${kind} ${n++}`;
          taken.add(name);
          for (const p of own) p.assembly = name;
          model.steps = model.steps.map((s) => (s.assembly === a ? { ...s, assembly: name } : s));
          renamed.push(`${a} → ${name}`);
        }
        return `Named sections from their shape: ${renamed.slice(0, 4).join(', ')}${renamed.length > 4 ? '…' : ''}.`;
      },
    };
  },
];

// The model's colour list and parts inventory counted again from its parts, after a fix changed colours:
// otherwise a recoloured part has a colour the list does not name, and the inventory (what gets
// ordered) is short of it.
function recount(model) {
  const colors = {}, inv = new Map();
  for (const p of model.parts) {
    const col = BY_CODE.get(p.color);
    if (col) colors[p.color] = { name: col.name, hex: col.hex };
    const k = `${p.id}/${p.color}`;
    inv.set(k, (inv.get(k) || 0) + 1);
  }
  const before = new Map((model.inventory ?? []).map((i) => [`${i.id}/${i.color}`, i]));
  model.colors = colors;
  if (model.inventory) model.inventory = [...inv].map(([k, quantity]) => {
    const [id, color] = k.split('/'), col = BY_CODE.get(Number(color));
    return { ...(before.get(k) ?? { id, name: model.catalog?.[id]?.name ?? id }), color: Number(color), colorName: col?.name, hex: col?.hex, quantity };
  }).sort((a, b) => b.quantity - a.quantity);
}

// Merge neighbouring steps of the same section (smallest pairs first) until
// there are at most `target`, none bigger than `cap`. Merging neighbours
// keeps the build order, so the rules still hold.
function squeeze(steps, target, cap) {
  const out = steps.map((s) => ({ ...s, parts: [...s.parts] }));
  const ok = (a, b) => a && b && !a.attach && !b.attach && !a.pinned && !b.pinned && a.assembly === b.assembly && !!a.aside === !!b.aside && a.parts.length + b.parts.length <= cap;
  // First the single-part steps, then the smallest pairs while there are too many.
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      if (out[i].parts.length !== 1 || out[i].attach || out[i].aside || out[i].pinned) continue;
      const j = ok(out[i - 1], out[i]) ? i - 1 : ok(out[i], out[i + 1]) ? i : -1;
      if (j < 0) continue;
      out.splice(j, 2, { ...out[j], parts: [...out[j].parts, ...out[j + 1].parts] });
      changed = true;
      break;
    }
  }
  while (out.length > target) {
    let best = -1, size = Infinity;
    for (let i = 0; i + 1 < out.length; i++) if (ok(out[i], out[i + 1]) && out[i].parts.length + out[i + 1].parts.length < size) { best = i; size = out[i].parts.length + out[i + 1].parts.length; }
    if (best < 0) break;
    out.splice(best, 2, { ...out[best], parts: [...out[best].parts, ...out[best + 1].parts] });
  }
  return out;
}

// Review a model: run every check, fix what can be fixed, check again (a fix
// can uncover something), and record it all. Returns the review.
export function review(model, { fix = true, rounds = 3 } = {}) {
  const fixes = [], findings = [];
  for (let round = 0; round < rounds; round++) {
    let changed = false;
    for (const check of CHECKS) {
      const r = check(model);
      if (!r.finding) continue;
      if (fix && r.fix) { fixes.push({ check: check.name, found: r.finding, did: r.fix(), evidence: r.evidence }); changed = true; }
      else if (round === 0 || !findings.some((f) => f.check === check.name)) findings.push({ check: check.name, found: r.finding });
    }
    if (!changed) break;
  }
  const result = { ...REVIEWER, checks: CHECKS.length, fixes, open: findings, steps: model.steps.length, titles: titles(model.steps).length };
  model.provenance = { ...(model.provenance ?? {}), review: result };
  return result;
}
