// Parts designed by hand (the workbench's part designer): a brick, plate,
// tile or round part of any size, studs on top or not (or one stud in the
// middle, like a jumper), optionally printed on top. Pure: no DOM.
//
// A design is a catalogue entry { id, name, w, d, h, shape, studs, custom,
// kind, top, print }; the id says what it is, so the same design is the same
// part. It travels in LDraw files as a part of its own (an MPD subfile with
// a "0 !NOOKS PART" line holding the design), so reading the file back gives
// the design again. A print stays in the model's own file (LDraw has no
// pictures in its plain form).

export const KINDS = { brick: { h: 3, label: 'Brick' }, plate: { h: 1, label: 'Plate' }, tile: { h: 1, label: 'Tile' }, round: { h: 3, label: 'Round brick' } };
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36); };

// A design from its settings, limited to what can be made (1–16 studs a side, 1–24 plates high).
export function customPart({ kind = 'brick', w = 2, d = 2, h = null, top = null, print = null, name = '' } = {}) {
  const k = KINDS[kind] ? kind : 'brick';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || lo)));
  w = clamp(w, 1, 16); d = clamp(d, 1, 16); h = clamp(h ?? KINDS[k].h, 1, 24);
  if (k === 'round') d = w;                                       // round parts are round
  top = top ?? (k === 'tile' ? 'smooth' : 'studs');
  const id = `nk-${k}-${w}x${d}x${h}-${top}${print ? `-${hash(print)}` : ''}`;
  const size = `${w} x ${d}${h !== KINDS[k].h ? ` x ${h % 3 === 0 ? h / 3 : `${h}/3`}` : ''}`;
  const auto = `${KINDS[k].label} ${size}${top === 'smooth' && k !== 'tile' ? ' smooth' : top === 'jumper' ? ' with 1 Stud (Jumper)' : ''}${print ? ' printed' : ''}`;
  return {
    id, name: String(name).trim() || `${auto} (custom)`, w, d, h, kind: k, top, custom: true,
    shape: k === 'round' ? 'round' : top === 'smooth' ? 'tile' : undefined,
    studs: top === 'smooth' ? false : undefined,
    ...(print ? { print } : {}),
  };
}

// The design as an LDraw part: its body (LDraw units, y down, origin on the
// middle of its top face) and its studs, as the standard stud primitive.
export function customLDraw(def) {
  const W = def.w * 10, D = def.d * 10, H = def.h * 8, q = (...pts) => `4 16 ${pts.flat().join(' ')}`;
  const lines = [`0 ${def.name}`, `0 Name: ${def.id}.dat`, '0 Author: Nooks Create (part designer)', `0 !NOOKS PART ${JSON.stringify({ ...def, print: undefined })}`, '0 BFC CERTIFY CCW', ''];
  if (def.kind === 'round') {
    // A round part: its cylinder from the standard primitives.
    lines.push(`1 16 0 0 0 ${W} 0 0 0 ${H} 0 0 0 ${D} 4-4cyli.dat`, `1 16 0 0 0 ${W} 0 0 0 1 0 0 0 ${D} 4-4disc.dat`, `1 16 0 ${H} 0 ${W} 0 0 0 -1 0 0 0 ${D} 4-4disc.dat`);
  } else {
    const top = [[-W, 0, -D], [W, 0, -D], [W, 0, D], [-W, 0, D]], bot = [[-W, H, D], [W, H, D], [W, H, -D], [-W, H, -D]];
    lines.push(q(...top), q(...bot), q([-W, 0, D], [W, 0, D], [W, H, D], [-W, H, D]), q([W, 0, -D], [-W, 0, -D], [-W, H, -D], [W, H, -D]),
      q([W, 0, D], [W, 0, -D], [W, H, -D], [W, H, D]), q([-W, 0, -D], [-W, 0, D], [-W, H, D], [-W, H, -D]));
  }
  if (def.top === 'jumper') lines.push('1 16 0 0 0 1 0 0 0 1 0 0 0 1 stud.dat');
  else if (def.top !== 'smooth') for (let i = 0; i < def.w; i++) for (let k = 0; k < def.d; k++) {
    if (def.kind === 'round' && Math.hypot(i + 0.5 - def.w / 2, k + 0.5 - def.d / 2) > def.w / 2) continue;
    lines.push(`1 16 ${(i + 0.5) * 20 - W} 0 ${(k + 0.5) * 20 - D} 1 0 0 0 1 0 0 0 1 stud.dat`);
  }
  return lines.join('\n') + '\n';
}

// A design back from its "0 !NOOKS PART" line, or null.
export function customFromLDraw(lines) {
  for (const l of lines) { const m = /^0\s+!NOOKS\s+PART\s+(\{.*\})\s*$/.exec(l); if (m) { try { const d = JSON.parse(m[1]); return d?.id?.startsWith('nk-') ? { ...d, custom: true } : null; } catch { return null; } } }
  return null;
}
