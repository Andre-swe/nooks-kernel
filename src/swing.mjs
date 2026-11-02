// Swinging a hinge: which joint a drag on a part turns, the parts turned about
// it, and how far they get before they hit something. Built on the connection
// graph (lib/graph.mjs: bodies and joints) and the collision shapes
// (lib/hulls.mjs). Pure: the caller loads the tables.
// Phase 1 (docs/PHASE1_CONTRACTS.md §10 E).
import { rotateParts, worldBox } from './studio.mjs';
import { frameOf } from './frames.mjs';
import { hullsOf, hullsFor, clashHulls, joined } from './hulls.mjs';
import { hingeOf } from './studs.mjs';

const TURNS = new Set(['turn', 'turn+slide']);
const GAP = 2;               // mm: parts further apart than this cannot touch
const STEP = 3;              // degrees between the poses a sweep checks
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// The same line (parallel axes, one through the other's point): two fingers of one hinge are one joint.
function collinear(a, b) {
  if (Math.abs(dot(a.axis, b.axis)) < 0.995) return false;
  const d = b.at.map((v, i) => v - a.at[i]), t = dot(d, a.axis);
  return Math.hypot(...d.map((v, i) => v - t * a.axis[i])) < 0.5;
}

// The joint a drag on `part` turns, or null. `ground`: the main build's floor
// parts (a Set or array); a body that holds one is the base and never swings.
// Of the joints that leave the part's side hanging off the ground, the first
// one crossed going from the part toward the ground (a door on a hinge on a
// wall swings the door, not the wall). `catalog` names the hinge for its clicks.
// → { joint, moving, fixed, at, axis, step } (mm; `fixed` is the side across the joint).
export function swingOf(graph, part, ground, catalog = {}) {
  const base = new Set(ground ?? []);
  if (!base.size) return null;
  const start = graph.bodyOf(part);
  if (start.some((p) => base.has(p))) return null;
  // Bodies as nodes (by their parts array, the same object for each ask) and turning joints as the edges between them.
  const js = graph.joints().map((j) => ({ ...j, x: graph.bodyOf(j.parts[0]), y: graph.bodyOf(j.parts[1]) })).filter((j) => j.x !== j.y);
  if (!js.length) return null;
  const hasGround = (body) => body.some((p) => base.has(p));
  // What is reached from `from` without the joints in `cut`: the bodies, the ground reached or not.
  function flood(from, cut) {
    const seen = new Set([from]), todo = [from];
    let ground = hasGround(from);
    while (todo.length) {
      const b = todo.pop();
      for (const j of js) {
        if (cut.has(j)) continue;
        const o = j.x === b ? j.y : j.y === b ? j.x : null;
        if (!o || seen.has(o)) continue;
        seen.add(o); todo.push(o);
        if (hasGround(o)) ground = true;
      }
    }
    return { seen, ground };
  }
  // Breadth first from the part's body: the nearer joint is tried first.
  const order = [], seen = new Set([start]), queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const b = queue[i];
    for (const j of js) {
      const o = j.x === b ? j.y : j.y === b ? j.x : null;
      if (!o) continue;
      if (!order.includes(j)) order.push(j);
      if (!seen.has(o)) { seen.add(o); queue.push(o); }
    }
  }
  for (const j of order) {
    if (!TURNS.has(j.dof)) continue;
    // Every joint between the same two bodies goes when this one does; if they are not one line, the pair is held rigid.
    const twins = js.filter((k) => (k.x === j.x && k.y === j.y) || (k.x === j.y && k.y === j.x));
    if (twins.some((k) => !TURNS.has(k.dof) || !collinear(j, k))) continue;
    const cut = new Set(twins), side = flood(start, cut);
    if (side.ground) continue;
    // (the far side: everything reached from across the joint)
    const across = flood(start === j.x ? j.y : j.x, cut).seen;
    const step = [j.parts[0], j.parts[1]].map((p) => hingeOf(p, catalog)).find((h) => h)?.step ?? null;
    return { joint: j, moving: [...side.seen].flat(), fixed: [...across].flat(), at: j.at, axis: j.axis, step };
  }
  return null;
}

// The parts turned `degrees` about the line through `at` (mm) along `axis`, as copies.
export function swingTo(moving, at, axis, degrees, frames) {
  return rotateParts(moving, axis, degrees, (id) => frameOf(id, frames), { pivot: at });
}

// The parts of `others` the swinging parts could reach: within the farthest point of
// the swinging side from `at` (mm), to a gap's width. A swing is checked against these only.
export function around(moving, others, at) {
  let reach = 0;
  for (const p of moving) { const b = worldBox(p); for (const x of [b[0], b[3]]) for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) reach = Math.max(reach, Math.hypot(x - at[0], y - at[1], z - at[2])); }
  const gap = (b) => Math.hypot(...[0, 1, 2].map((k) => Math.max(b[k] - at[k], 0, at[k] - b[k + 3])));
  return others.filter((f) => gap(worldBox(f)) <= reach + GAP);
}

// The furthest angle from `from` to `to` (degrees, either way round) that the
// moving parts reach without passing into a fixed part; every 3° and at `to`.
// `ctx`: { hulls, frames, joints } (the tables). Parts that form the joint
// itself (a pin in its hole) are not counted. `from` is taken as clear.
export function sweep(moving, fixed, at, axis, from, to, ctx) {
  if (from === to) return to;
  const sign = to > from ? 1 : -1, n = Math.ceil(Math.abs(to - from) / STEP - 1e-9);
  const wall = around(moving, fixed, at).map((f) => ({ f, hs: hullsFor(f, ctx), box: worldBox(f) })).filter((w) => w.hs);
  if (!wall.length) return to;
  let good = from;
  for (let k = 1; k <= n; k++) {
    const angle = k === n ? to : from + sign * STEP * k;
    const turned = swingTo(moving, at, axis, angle, ctx.frames);
    if (!turned) return good;
    for (const m of turned) {
      const mb = worldBox(m), hm = hullsOf(m, ctx);
      if (!hm) continue;
      for (const w of wall) {
        if (!(w.box[0] <= mb[3] + GAP && mb[0] <= w.box[3] + GAP && w.box[1] <= mb[4] + GAP && mb[1] <= w.box[4] + GAP && w.box[2] <= mb[5] + GAP && mb[2] <= w.box[5] + GAP)) continue;
        if (joined(m, w.f, ctx)) continue;
        if (clashHulls(hm, w.hs)) return good;
      }
    }
    good = angle;
  }
  return good;
}
