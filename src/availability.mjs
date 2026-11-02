// Which colours each part is actually made in (Rebrickable's element list,
// built into data/catalog/catalog.json by scripts/build-catalog.mjs). A design
// only uses part-and-colour pairs that exist.
import catalog from '../data/catalog/catalog.json' with { type: 'json' };
import { BY_CODE, hexToRgb, rgbToLab } from './palette.mjs';

const made = new Map(Object.entries(catalog.parts).map(([id, p]) => [id, new Set(p.colours)]));

// True when LEGO has made `id` in `colour` (or we know nothing about the part).
export function isMade(id, colour) {
  const set = made.get(id);
  return !set || set.has(colour);
}

// The real name of a part, when the catalogue has it.
export const partName = (id) => catalog.parts[id]?.name ?? null;

// The nearest colour this part is made in, among the colours we can show.
const labs = new Map();
const lab = (code) => { if (!labs.has(code)) { const c = BY_CODE.get(code); labs.set(code, c ? rgbToLab(hexToRgb(c.hex)) : null); } return labs.get(code); };
export function nearestMade(id, colour) {
  const set = made.get(id);
  if (!set) return colour;
  return nearestIn(set, colour);
}
// The nearest of `colours` (codes a part is made in) to `colour`, of the same finish.
export function nearestIn(colours, colour) {
  const set = colours instanceof Set ? colours : new Set(colours);
  if (set.has(colour)) return colour;
  const want = lab(colour), trans = !!BY_CODE.get(colour)?.trans;
  let best = colour, bd = Infinity;
  for (const c of set) {
    const l = lab(c);
    if (!l || !!BY_CODE.get(c)?.trans !== trans) continue;
    const d = (l[0] - want[0]) ** 2 + (l[1] - want[1]) ** 2 + (l[2] - want[2]) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

export const CATALOG_SOURCE = { source: catalog.source, built: catalog.built, parts: Object.keys(catalog.parts).length };
