// What a gravity test found (assembly-physics.mjs's report), as things a person can act on: each pair of parts that
// overlap, and each rigid group that moved more than the limit, said in plain words with what would fix it. The
// workbench lists them (Scene › Test gravity), marks their parts and selects them when one is chosen. Pure.
//
// `result`: the report ({ status, clashes: [[i, j]], components: [{ parts: [i], peakLDU }], thresholdLDU }), its
// part indices into `parts`: the workbench parts simulated, in the order the test had them. `floor`: the plate the
// model stands on (a group with a part there rests on the table). `name(part)`: what to call a part.
// → [{ kind: 'overlap' | 'tips' | 'falls', keys: [part keys], title, fix, mm? }], overlaps first, then by how far
// the group moved.
export const LDU_MM = 0.4;
export function gravityFindings(result, parts, { floor = Math.min(...parts.filter((p) => !p.origin).map((p) => p.y)), name = (p) => p.id } = {}) {
  const out = [], seen = new Set();
  const the = (p) => `The ${name(p)}`;
  for (const [i, j] of result?.clashes ?? []) {
    const a = parts[i], b = parts[j], k = `${Math.min(i, j)}|${Math.max(i, j)}`;
    if (!a || !b || seen.has(k)) continue;
    seen.add(k);
    out.push({ kind: 'overlap', keys: [a.key, b.key], title: `${the(a)} and the ${name(b)} overlap`, fix: 'These two pass into each other: move one of them, or take one out. Gravity is tested once nothing overlaps.' });
  }
  const limit = result?.thresholdLDU ?? 3, moved = [];
  for (const c of result?.components ?? []) {
    if (!(c.peakLDU > limit)) continue;
    const group = c.parts.map((i) => parts[i]).filter(Boolean);
    if (!group.length) continue;
    const mm = Math.round(c.peakLDU * LDU_MM * 10) / 10, one = group.length === 1;
    const what = one ? the(group[0]) : `${group.length} parts held together`;
    // On the table and still moving: it tips over. Up off it: nothing below holds it.
    const rests = group.some((p) => !p.origin && Math.abs(p.y - floor) < 1e-6);
    moved.push(rests
      ? { kind: 'tips', keys: group.map((p) => p.key), mm, title: `${what} ${one ? 'tips' : 'tip'} over`, fix: `${one ? 'It moved' : 'They moved'} ${mm} mm: the weight is past what ${one ? 'it stands' : 'they stand'} on. Widen the base under ${one ? 'it' : 'them'}, or move weight back over it.` }
      : { kind: 'falls', keys: group.map((p) => p.key), mm, title: `${what} ${one ? 'falls' : 'fall'}`, fix: `${one ? 'It isn’t' : 'This group isn’t'} attached to anything below: connect it to the build (studs, a pin or a clip), or rest it on the table.` });
  }
  moved.sort((a, b) => b.mm - a.mm);
  return [...out, ...moved];
}
