// "Holds together" on BrickNet's connectors (docs/BUILD_BY_CONNECTOR.md, gate 4). What holds what has three
// sources, and this decides which counts:
//   - the geometric base, as lib/edit.mjs connectivity() always had it: studs on the grid into undersides, figures
//     and plants by what they touch, parts on their side face to face, floor plates edge to edge;
//   - BrickNet's connector joins (lib/assembly.mjs connections, the joins agents' `check` uses): studs, pins,
//     axles, bars in clips, hinges and balls, for every part BrickNet has;
//   - LDCad's connector mates (lib/graph.mjs), now only where a part BrickNet lacks is one end of the join.
// So a person in the workbench and an agent over MCP are told the same thing of a build. Pure: the caller passes
// BrickNet's tables (lib/bricknet.mjs load) and a frame lookup (lib/frames.mjs framesFrom).
import { connections, partBox } from './assembly.mjs';
import { poseOf } from './bridge.mjs';

const PAD = 8;   // LDU around a part's box: further than any join connections() makes reaches (studs 3, an axle's end 4)

const meets = (a, b) => a[0][0] <= b[1][0] + PAD && b[0][0] <= a[1][0] + PAD && a[0][1] <= b[1][1] + PAD && b[0][1] <= a[1][1] + PAD && a[0][2] <= b[1][2] + PAD && b[0][2] <= a[1][2] + PAD;
const poseKey = (p) => `${p.id}|${p.x}|${p.y}|${p.z}|${p.rotation}|${(p.ldMatrix ?? []).join(',')}|${JSON.stringify(p.origin ?? null)}|${p.flex ? 1 : 0}`;

// BrickNet's joins between a model's parts, by part key. → { links: Map<key, Set<key>>, at: Map<key, { stem, pose,
// box, pk }>, lacks: Set<key> } (lacks: parts BrickNet has no data for, and hoses and strings, which bend).
// `from` (the answer before an edit) and `changed` (the keys it added, moved or removed) make it again for only the
// changed parts and those whose boxes meet theirs; `from` is spent by it.
export function bricknetLinks(model, T, geom, from = null, changed = null) {
  const parts = model.parts;
  if (!from || !changed) {
    const at = new Map(), lacks = new Set();
    for (const p of parts) place(p, at, lacks, T, geom);
    const links = new Map();
    joinAll([...at.entries()], links, T, null);
    return { links, at, lacks };
  }
  const { links, at, lacks } = from;
  const byKey = new Map(parts.map((p) => [p.key, p]));
  // Parts whose pose didn't change are kept as they are, even if the page said they did.
  const moved = new Set();
  // (and parts BrickNet lacked whose connectors have come in since)
  for (const k of lacks) { const p = byKey.get(k); if (!p || (!p.flex && poseOf(p, T, geom))) moved.add(k); }
  for (const k of changed) {
    const p = byKey.get(k), had = at.get(k);
    if (p && had && had.pk === poseKey(p)) continue;
    if (p && !had && lacks.has(k) && !poseOf(p, T, geom)) continue;
    moved.add(k);
  }
  for (const k of moved) {
    for (const q of links.get(k) ?? []) links.get(q)?.delete(k);
    links.delete(k); at.delete(k); lacks.delete(k);
    const p = byKey.get(k);
    if (p) place(p, at, lacks, T, geom);
  }
  if (!moved.size) return { links, at, lacks };
  const mine = [...moved].map((k) => at.get(k)).filter(Boolean);
  if (!mine.length) return { links, at, lacks };
  const near = [];
  for (const e of at.entries()) if (moved.has(e[0]) || mine.some((m) => meets(m.box, e[1].box))) near.push(e);
  joinAll(near, links, T, moved);
  return { links, at, lacks };
}

function place(p, at, lacks, T, geom) {
  const pose = p.flex ? null : poseOf(p, T, geom);
  if (!pose) { lacks.add(p.key); return; }
  at.set(p.key, { stem: pose.stem, pose: pose.pose, box: partBox(pose, T), pk: poseKey(p) });
}
// connections() over `entries` ([key, at]); joins with an end in `only` (all when null) go into `links`.
function joinAll(entries, links, T, only) {
  const flat = entries.map(([, a]) => ({ stem: a.stem, pose: a.pose, where: '' }));
  const { edges } = connections(null, T, flat);
  for (const [i, , j] of edges) {
    const a = entries[i][0], b = entries[j][0];
    if (a === b || (only && !only.has(a) && !only.has(b))) continue;
    let s = links.get(a); if (!s) links.set(a, (s = new Set())); s.add(b);
    let t = links.get(b); if (!t) links.set(b, (t = new Set())); t.add(a);
  }
}

// What lib/edit.mjs connectivity() and recompute() are given as `links`: BrickNet's joins, and the connection
// graph's connector mates (lib/graph.mjs) only where one end is a part BrickNet lacks. `graph` may be null.
export function holdsLinks(model, bn, graph = null) {
  const byKey = new Map(model.parts.map((p) => [p.key, p]));
  return {
    bricknet: true,
    pairs(f) {
      if (graph) graph.pairs((a, b) => { if (bn.lacks.has(a.key) || bn.lacks.has(b.key) || !bn.at.has(a.key) || !bn.at.has(b.key)) f(a, b); });
      for (const [a, set] of bn.links) { const p = byKey.get(a); if (p) for (const b of set) if (a < b) { const q = byKey.get(b); if (q) f(p, q); } }
    },
    links(p) {
      const out = new Set();
      if (graph) for (const q of graph.links(p)) if (!graph.base?.links(p).has(q) && (bn.lacks.has(p.key) || bn.lacks.has(q.key))) out.add(q);
      for (const k of bn.links.get(p.key) ?? []) { const q = byKey.get(k); if (q) out.add(q); }
      return out;
    },
  };
}
