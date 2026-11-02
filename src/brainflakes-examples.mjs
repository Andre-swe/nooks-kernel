// Synthetic candidate graphs for development; not validated physical designs.
import { createAssembly, addDisc, attachDisc, validateAssembly, MAX_DISCS } from './brainflakes.mjs';

export function flowerCandidate(def) {
  const a = createAssembly('Brain Flakes flower candidate');
  addDisc(a, { id: 'center', color: 'yellow' });
  for (let i=0;i<8;i++) attachDisc(a, def, { id: `petal-${i+1}`, color: 'pink', to: 'center', slot: i, by: 0 });
  a.provenance.example = 'synthetic candidate; not physically verified';
  a.validation = validateAssembly(a, def, { maxParts: 40 });
  return a;
}
export function chainCandidate(def, count = 32) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_DISCS) throw new Error(`Choose 1–${MAX_DISCS} discs.`);
  const a = createAssembly('Brain Flakes chain candidate'); addDisc(a, { id: 'disc-1', color: 'light-blue' });
  for (let i=2;i<=count;i++) attachDisc(a, def, { id: `disc-${i}`, color: 'light-blue', to: `disc-${i-1}`, slot: i === 2 ? 0 : 4, by: 0 });
  a.provenance.example = 'synthetic candidate; not physically verified';
  a.validation = validateAssembly(a, def);
  return a;
}
