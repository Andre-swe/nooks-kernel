// Nooks Build Bench (a provisional name): benchmark tasks and the independent software checks a
// submitted model is scored with. Pure: no DOM, no network, no clock; the same model and task give
// the same result, so anyone can run the evaluator again and get the same answer.
//
// What it checks is what software can decide from the part list: the stud-connection graph (every part
// held through studs), a piece budget, a size, a palette, a parts inventory, stock parts only, no two
// parts inside each other (by their collision shapes, lib/hulls.mjs, when the caller passes the tables),
// and whether the model, taken as one rigid body on a desk, stays standing (lib/mass.mjs). Every failed
// check names the parts it is about, so a person or an agent can go straight to them. What it does not
// check is said in every result, never implied: whether the clutch between parts carries the load and
// survives handling, whether a person can assemble it in that order, and whether it looks like the
// subject. Those need a real build and a person's eye (lib/judge.mjs adds an AI judge's opinion of the
// last, kept apart and labelled as such).
import { worldBox } from './studio.mjs';
import { BY_CODE, PALETTE } from './palette.mjs';
import { hullsFor, clashHulls, joined } from './hulls.mjs';
import { statics } from './mass.mjs';

export const EVALUATOR = 'nooks-build-bench-v2';

export const NOT_VERIFIED = [
  { id: 'physical', label: 'Physical buildability', detail: 'Not verified. The software checks only whether the whole model, as one rigid body, would tip over on a desk (an estimate from part volumes). It cannot tell how strongly parts clutch, whether an overhang sags or snaps off, or whether the model survives handling. Only a real build shows that.' },
  { id: 'assembly', label: 'Assembly by hand', detail: 'Not verified. The manual\'s order is planned so no part comes before what holds it, but reach, tolerances and fiddly steps are not checked.' },
  { id: 'visual', label: 'Visual quality and resemblance', detail: 'Not scored. Whether it looks good or reads as its subject is a human judgement; a reviewer\'s approval means it meets the community guidelines, not that it was scored.' },
];

const LIMIT = { pieces: 20000, mm: 10000, colours: 64, inventoryParts: 5000 };
// Colour names as people and other tools write them: "Dark bluish grey", "dark_bluish_gray".
const colourKey = (name) => String(name).trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\bgray\b/g, 'grey').replace(/\s+/g, ' ');
const nameToCode = new Map(PALETTE.map((c) => [colourKey(c.name), c.code]));
export const colourCode = (c) => {
  const code = typeof c === 'string' ? (/^\d+$/.test(c.trim()) ? Number(c) : nameToCode.get(colourKey(c))) : c;
  if (!Number.isInteger(code) || !BY_CODE.has(code)) throw new Error(`Unknown colour: ${String(c).slice(0, 40)}.`);
  return code;
};
// A part id as LDraw files and inventories write it: "3001.dat", "parts\3001.dat", "3001".
export const partKey = (id) => String(id).trim().toLowerCase().replace(/\\/g, '/').replace(/^parts\//, '').replace(/\.dat$/, '');

// A parts inventory: { "3001": { "Red": 8, "Blue": 6 }, "3020": null }. Per part, each colour's most
// pieces (null: as many as wanted), or null for the part in any colour and number. A part not listed is
// not allowed. It is the shape of BrickAgent's BRICKAGENT_SET file, so those inventories load as they are.
export function normaliseInventory(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('An inventory maps part ids to colours and counts.');
  const entries = Object.entries(value);
  if (!entries.length || entries.length > LIMIT.inventoryParts) throw new Error(`An inventory lists 1 to ${LIMIT.inventoryParts} parts.`);
  const out = {};
  for (const [id, colours] of entries) {
    const key = partKey(id);
    if (!key || key.length > 64) throw new Error('Inventory part ids are 1 to 64 characters.');
    if (colours === null) { out[key] = null; continue; }
    if (!colours || typeof colours !== 'object' || Array.isArray(colours)) throw new Error(`Part ${key}: give its colours and counts, or null for any.`);
    const per = out[key] ?? {};
    for (const [c, n] of Object.entries(colours)) {
      if (n !== null && !(Number.isInteger(n) && n >= 0 && n <= LIMIT.pieces)) throw new Error(`Part ${key}: a count is a whole number from 0 to ${LIMIT.pieces}, or null.`);
      per[colourCode(c)] = n;
    }
    out[key] = per;
  }
  return out;
}

// A task's constraints, checked and normalised; throws an Error with a plain message when they are not usable.
export function normaliseConstraints(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Provide task constraints.');
  const out = {};
  const int = (v, label, lo, hi) => {
    if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${label} must be a whole number from ${lo} to ${hi}.`);
    return v;
  };
  out.maxPieces = int(value.maxPieces, 'The piece limit', 1, LIMIT.pieces);
  if (value.minPieces !== undefined && value.minPieces !== null) {
    out.minPieces = int(value.minPieces, 'The minimum piece count', 1, LIMIT.pieces);
    if (out.minPieces > out.maxPieces) throw new Error('The minimum piece count is above the limit.');
  }
  if (value.maxDimensionsMm !== undefined && value.maxDimensionsMm !== null) {
    const d = value.maxDimensionsMm;
    if (!Array.isArray(d) || d.length !== 3 || d.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > LIMIT.mm)) throw new Error('Size limits are three millimetre values (length, width, height), each above 0 and at most 10000.');
    out.maxDimensionsMm = d.map((n) => Math.round(n * 10) / 10);
  }
  if (value.allowedColours !== undefined && value.allowedColours !== null) {
    const list = value.allowedColours;
    if (!Array.isArray(list) || !list.length || list.length > LIMIT.colours) throw new Error(`Allowed colours are a list of 1 to ${LIMIT.colours} colours.`);
    out.allowedColours = [...new Set(list.map(colourCode))].sort((a, b) => a - b);
  }
  if (value.inventory !== undefined && value.inventory !== null) out.inventory = normaliseInventory(value.inventory);
  out.requireConnected = value.requireConnected !== false;
  out.requireStands = value.requireStands !== false;
  out.stockPartsOnly = value.stockPartsOnly !== false;
  return out;
}

// Pairs of parts inside each other. With `tables` ({ hulls, frames, joints }: the `parts` of ldraw/
// hulls.json, frames.json and joints.json) a part the table knows is tested by its collision shape, so
// a slope's empty wedge is empty and a part turned off the grid is tested where it really is; a pin in
// its hole or a clip on its bar (`joined`) is meant to meet and is no clash. A part the table does not
// know, and every part without tables, is its box: boxes may overlap by a stud's height (a stud sitting
// in the part above is how parts join). Organic parts the table does not know (figures, plants, designed
// parts) are left out. A grid of 8 mm cells keeps it near linear.
const BOX_ALLOW = 1.8, HULL_ALLOW = 1.7;
const boxy = (p) => !p.origin && !p.ldMatrix && p.shape !== 'custom' && !/^(tree|bush|leaves|flower)/.test(p.shape ?? '');
const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
function solidOf(p, tables) {
  const hs = tables?.hulls ? hullsFor(p, tables) : null;
  if (hs?.length) return { hs, exact: true };
  if (!boxy(p)) return null;
  const b = worldBox(p);
  return { hs: [{ c: [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2], h: [(b[3] - b[0]) / 2, (b[4] - b[1]) / 2, (b[5] - b[2]) / 2], R: I3 }], exact: false };
}
// Across the desk (x, z), what a part's boxes reach.
function spanOf(hs) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const b of hs) {
    const ex = Math.abs(b.R[0]) * b.h[0] + Math.abs(b.R[1]) * b.h[1] + Math.abs(b.R[2]) * b.h[2];
    const ez = Math.abs(b.R[6]) * b.h[0] + Math.abs(b.R[7]) * b.h[1] + Math.abs(b.R[8]) * b.h[2];
    x0 = Math.min(x0, b.c[0] - ex); x1 = Math.max(x1, b.c[0] + ex); z0 = Math.min(z0, b.c[2] - ez); z1 = Math.max(z1, b.c[2] + ez);
  }
  return [x0, z0, x1, z1];
}
export function overlaps(model, max = 20, tables = null) {
  const solids = model.parts.map((p) => solidOf(p, tables));
  const cells = new Map(), found = [], seen = new Set();
  const cell = (v) => Math.floor(v / 8);
  solids.forEach((s, i) => {
    if (!s || found.length >= max) return;
    const [x0, z0, x1, z1] = spanOf(s.hs);
    for (let x = cell(x0); x <= cell(x1 - 0.01); x++) for (let z = cell(z0); z <= cell(z1 - 0.01); z++) {
      const k = `${x},${z}`, here = cells.get(k);
      if (!here) { cells.set(k, [i]); continue; }
      for (const j of here) {
        const pair = j < i ? `${j}:${i}` : `${i}:${j}`;
        if (seen.has(pair) || found.length >= max) continue;
        seen.add(pair);
        const t = solids[j], exact = s.exact && t.exact;
        if (!clashHulls(t.hs, s.hs, exact ? HULL_ALLOW : BOX_ALLOW)) continue;
        if (exact && tables.joints && joined(model.parts[j], model.parts[i], tables)) continue;
        found.push([model.parts[j].key ?? j, model.parts[i].key ?? i]);
      }
      here.push(i);
    }
  });
  return found;
}

const isDesigned = (p) => p.shape === 'custom' || /^nk-/.test(String(p.id));

// How a part list uses an inventory: `over`, lines for people; `named`, the keys of the parts past a
// count (the last ones of their kind) or not in it at all.
function inventoryUse(parts, inventory, keyOf) {
  const seen = new Map(), missing = new Map(), past = new Map(), over = [], named = [];
  parts.forEach((p, i) => {
    const id = partKey(p.id), allowed = inventory[id];
    if (allowed === null) return;
    if (allowed === undefined) { missing.set(id, (missing.get(id) ?? 0) + 1); named.push(keyOf(p, i)); return; }
    const limit = allowed[p.color];
    if (limit === null) return;
    const k = `${id}|${p.color}`, used = (seen.get(k) ?? 0) + 1;
    seen.set(k, used);
    if (limit === undefined || used > limit) { past.set(k, { id, color: p.color, used, limit: limit ?? 0 }); named.push(keyOf(p, i)); }
  });
  for (const [id, count] of missing) over.push(`${count} × ${id}, not in it`);
  for (const { id, color, used, limit } of past.values()) over.push(`${used} × ${id} in ${BY_CODE.get(color)?.name ?? color}, ${limit} allowed`);
  return { over, named };
}

// The software checks of one model against one task. `model` must carry a validation the server worked
// out itself (a rebuild of the script, or the connection check run again on the parts), never one the
// submitter supplied. `tables` ({ hulls, frames, joints }) tests parts by their collision shapes;
// `volumes` (lib/mass.mjs) gives the balance real part volumes. Each check carries `parts`: the keys of
// the parts it is about (at most 200), empty when it passed or when it is about the whole model.
const NAMED = 200;
export function evaluate(model, constraints, { tables = null, volumes = null } = {}) {
  const c = normaliseConstraints(constraints);
  const parts = model?.parts ?? [];
  const checks = [];
  const keyOf = (p, i) => p.key ?? i;
  const add = (id, label, passed, detail, named = []) => checks.push({ id, label, passed: !!passed, detail, parts: passed ? [] : named.slice(0, NAMED) });
  const floating = model?.validation?.floating ?? [];
  const components = model?.validation?.components;
  if (c.requireConnected) add('connected', 'One connected assembly', model?.validation?.valid === true && floating.length === 0 && components === 1,
    floating.length ? `${floating.length} part${floating.length > 1 ? 's' : ''} not held by anything`
      : components === 1 ? 'One connected build, by the stud-connection graph'
        : Number.isInteger(components) ? `${components} separate assemblies; resting on the desk does not connect them`
          : 'The number of connected assemblies has not been verified', floating);
  const n = parts.length;
  add('pieces', 'Piece budget', n <= c.maxPieces && n >= (c.minPieces ?? 1), `${n} pieces; allowed ${c.minPieces ?? 1} to ${c.maxPieces}`);
  if (c.maxDimensionsMm) {
    const d = model?.dimensions ?? {}, have = [d.length, d.width, d.height];
    const ok = have.every((v, i) => Number.isFinite(v) && v <= c.maxDimensionsMm[i]);
    add('size', 'Size', ok, `${have.map((v) => (Number.isFinite(v) ? Math.round(v) : '?')).join(' × ')} mm; at most ${c.maxDimensionsMm.join(' × ')} mm`);
  }
  if (c.allowedColours) {
    const allowed = new Set(c.allowedColours), off = [...new Set(parts.map((p) => p.color).filter((k) => !allowed.has(k)))];
    add('palette', 'Colours', !off.length, off.length ? `Not allowed: ${off.slice(0, 6).map((k) => BY_CODE.get(k)?.name ?? k).join(', ')}` : `${new Set(parts.map((p) => p.color)).size} colours, all allowed`,
      parts.flatMap((p, i) => (allowed.has(p.color) ? [] : [keyOf(p, i)])));
  }
  if (c.inventory) {
    const { over, named } = inventoryUse(parts, c.inventory, keyOf);
    add('inventory', 'Parts inventory', !over.length, over.length ? `Over the inventory: ${over.slice(0, 6).join('; ')}${over.length > 6 ? '…' : ''}` : 'Every part is in the inventory, within its count', named);
  }
  if (c.stockPartsOnly) {
    const designed = parts.flatMap((p, i) => (isDesigned(p) ? [keyOf(p, i)] : []));
    add('stock', 'Stock parts only', designed.length === 0, designed.length ? `${designed.length} designed part${designed.length > 1 ? 's' : ''} that are not stock elements` : 'No designed parts', designed);
  }
  const inside = overlaps(model ?? { parts: [] }, 20, tables);
  add('overlap', 'No part inside another', inside.length === 0, inside.length ? `${inside.length}${inside.length >= 20 ? '+' : ''} pairs of parts pass into each other`
    : tables?.hulls ? 'Parts checked by their collision shapes; figures and plants without one are not' : 'Box-shaped parts checked; figures, plants and parts turned off the grid are not', [...new Set(inside.flat())]);
  let balance = null;
  if (c.requireStands && n) {
    const s = statics(model, { volumes });
    balance = { grams: Math.round(s.grams * 10) / 10, centre: s.centre, margin: s.margin, estimate: true };
    add('stands', 'Stands up', !s.tips, s.tips ? `Would tip over: its weight is ${Math.max(1, Math.round(-s.margin))} mm past its base (as one rigid body on a desk; an estimate)`
      : `Its weight is ${Math.max(0, Math.round(s.margin))} mm inside its base (as one rigid body on a desk; an estimate)`);
  }
  return {
    evaluator: EVALUATOR,
    constraints: c,
    software: { passed: checks.every((x) => x.passed), checks },
    notVerified: NOT_VERIFIED,
    pieces: n,
    dimensions: model?.dimensions ?? null,
    ...(balance ? { balance } : {}),
  };
}

// What failed, flat, for a person's problems list or an agent's next move: [{ check, label, detail, parts }].
export function problems(result) {
  return (result?.software?.checks ?? []).filter((x) => !x.passed).map(({ id, label, detail, parts }) => ({ check: id, label, detail, parts }));
}
