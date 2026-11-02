// Connector placements for the editor. The caller owns the spatial index and
// collision shapes; no loading, clocks or rendering belongs in this module.
import { compatible, placement } from './bricknet.mjs';
import { compose, inverse, toLDraw } from './pose.mjs';
import { poseOf, partFromPose } from './bridge.mjs';
import { connectorHash, fitOf, nameOf } from './record.mjs';
import { connections } from './assembly.mjs';
import { worldBox } from './studio.mjs';

const address = (c) => `${c.type}[${c.index}]`;
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const app = (v) => [v[0] / 2.5, -v[1] / 2.5, -v[2] / 2.5];

// Build once on entering Build, then update only changed entries. Names can be
// p<index> for imported base parts, or the recorded name for a placed part.
export function attachIndex(parts, T, geom, names = new Map()) {
  const hash = connectorHash(T), byName = new Map(), byKey = new Map();
  const drop = (key) => { const n = byKey.get(key); if (n !== undefined) { hash.drop(n); byName.delete(n); byKey.delete(key); } };
  const add = (p, named = names.get(p.key) ?? nameOf(p.key)) => {
    drop(p.key);
    const at = !p.flex && poseOf(p, T, geom);
    if (!at) return;
    const name = named;
    hash.add(name, at.stem, at.pose); byName.set(name, p); byKey.set(p.key, name);
  };
  parts.forEach((p) => add(p));
  return { hash, byName, byKey, add, drop };
}

// The upright poses one connector pair allows: each of the part's six axes pointed up (LDraw −y), where turning
// about the joint can do it, as `align` ops. Two that land the same are one.
const AXES = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
export function uprightsOf(T, target, source, opts = {}) {
  const out = [], seen = new Set();
  for (const u of AXES) {
    const align = [u, [0, -1, 0]];
    let at;
    try { at = placement(T, target, source, { ...opts, yaw: 0, align }); } catch { continue; }
    const signature = toLDraw(at).map((v) => +v.toFixed(7)).join();
    if (!seen.has(signature)) { seen.add(signature); out.push({ at, align }); }
  }
  return out;
}

// A connector by its address ("k12.stud[3]") as a hash entry, or null.
function pinnedTarget(index, target, T, geom) {
  const m = /^(.+)\.([^.[]+)\[(\d+)\]$/.exec(target), p = m && index.byName.get(m[1]), at = p && !p.flex && poseOf(p, T, geom);
  const conn = at && T.stems.get(at.stem).conns.find((c) => c.type === m[2] && c.index === +m[3]);
  return conn ? { name: m[1], stem: at.stem, conn, pose: compose(at.pose, conn.frame) } : null;
}

export function attachTries(held, hit, ctx, choice = {}) {
  const { T, geom, space } = ctx;
  if (!T || !(hit?.part || choice.target) || !held?.parts?.length) return [];
  const moving = held.moving ?? new Set(), poses = held.parts.map((p) => !p.flex && poseOf(p, T, geom));
  if (poses.some((p) => !p)) return []; // mixed groups use the legacy rigid transform
  const anchor = held.anchor ?? 0, source = poses[anchor];
  const index = ctx.index ?? attachIndex(ctx.model?.parts ?? [hit.part].filter(Boolean), T, geom, ctx.names);
  const pointer = [hit.point.x * 20, -hit.point.y * 8, -hit.point.z * 20];
  const occupied = ctx.occupied ?? new Set();
  const own = connections(null, T, poses.map((p) => ({ ...p, where: '' }))).edges;
  const used = new Set();
  for (const [i, ci, j, cj] of own) { used.add(`${i}:${ci}`); used.add(`${j}:${cj}`); }
  // (a pinned connector is the target wherever the pointer is)
  const pinned = choice.target && pinnedTarget(index, choice.target, T, geom);
  const targets = (pinned ? [pinned] : index.hash.near(pointer, 3)).filter((t) => {
    const p = index.byName.get(t.name);
    return p && !moving.has(p) && (pinned || distance(t.pose.t, pointer) <= 60) && !occupied.has(`${t.name}.${address(t.conn)}`) &&
      (!choice.target || choice.target === `${t.name}.${address(t.conn)}`);
  }).filter((t) => !index.hash.near(t.pose.t, 1).some((other) => {
    if (other.name === t.name || moving.has(index.byName.get(other.name)) || !compatible(t.conn, other.conn)) return false;
    const at = poseOf(index.byName.get(other.name), T, geom);
    return at && fitOf(T, t, { stem: at.stem, conn: other.conn }, at.pose);
  })).sort((a, b) => distance(a.pose.t, pointer) - distance(b.pose.t, pointer));
  const out = [], seen = new Set();
  let pair = 0;
  for (const target of targets) for (const conn of T.stems.get(source.stem).conns) {
    if (used.has(`${anchor}:${conn.i}`) || !compatible(target.conn, conn)) continue;
    const pairIndex = pair++;
    if (choice.pair !== undefined && pairIndex !== choice.pair) continue;
    const flips = choice.flip !== undefined ? [choice.flip] : ['axle', 'hinge'].includes(conn.kind) ? [false, true] : [false];
    // Continuous joints sample quarter turns by default. An explicit yaw,
    // align or orient can request any allowed angle; placement is authoritative.
    const yaws = choice.orient || choice.align || choice.upright !== undefined ? [0] : choice.yaw !== undefined ? [choice.yaw] : conn.kind === 'fixed' ? [0] : [0, 90, 180, 270];
    for (const flip of flips) for (const yaw of yaws) {
      const opts = { yaw, ...(flip ? { flip } : {}), ...(choice.slide ? { slide: choice.slide } : {}), ...(choice.align ? { align: choice.align } : {}), ...(choice.orient ? { orient: choice.orient } : {}) };
      let at, uprights = 0;
      if (choice.upright !== undefined && !choice.align && !choice.orient) {
        // Orient: which of the part's own faces points up, among those this joint can turn to.
        const ups = uprightsOf(T, target, { ...source, conn, pose: conn.frame }, opts);
        uprights = ups.length;
        if (!uprights) continue;
        ({ at, align: opts.align } = ups[((choice.upright % uprights) + uprights) % uprights]);
      } else {
        try { at = placement(T, target, { ...source, conn, pose: conn.frame }, opts); } catch { continue; }
      }
      const signature = toLDraw(at).map((v) => +v.toFixed(7)).join();
      if (seen.has(signature)) continue;
      seen.add(signature);
      const delta = compose(at, inverse(source.pose));
      const parts = held.parts.map((p, i) => partFromPose(p, compose(delta, poses[i].pose), T, geom));
      const mates = [], inexact = [];
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i], pp = compose(delta, poses[i].pose);
        for (const c of T.stems.get(poses[i].stem).conns) {
          const frame = compose(pp, c.frame);
          for (const t of index.hash.near(frame.t, 1)) {
            const q = index.byName.get(t.name);
            if (moving.has(q) || !compatible(t.conn, c)) continue;
            if (c.kind !== 'axle' && frame.t.some((v, j) => Math.abs(v - t.pose.t[j]) > 1e-6)) continue;
            if (!fitOf(T, t, { stem: poses[i].stem, conn: c }, pp)) continue;
            mates.push({ a: p, b: q, kind: c.kind, at: app(frame.t), axis: [frame.r[1], -frame.r[4], -frame.r[7]], dof: c.kind === 'fixed' ? 0 : 1 });
          }
        }
      }
      const blocker = parts.map((p) => worldBox(p)[1] < -0.5 ? hit.part ?? index.byName.get(target.name) : space?.blocker(p, moving)).find(Boolean);
      const p = held.parts[anchor];
      const op = { op: 'attach', name: nameOf(p.key), key: p.key, id: p.id, part: source.stem, color: p.color, who: 'human', to: `${target.name}.${address(target.conn)}`, by: [conn.type, conn.index], ...opts };
      if (choice.orient) op.orient = [{ ldraw: toLDraw(choice.orient) }];
      if (held.use) { op.use = held.use; delete op.part; op.by = held.by; }
      out.push({ parts, ok: !blocker, mates, inexact, ...(blocker ? { why: 'blocked', blocker } : {}), op, pair: pairIndex, target: op.to, distance: distance(target.pose.t, pointer), ...(uprights ? { upright: ((choice.upright % uprights) + uprights) % uprights, uprights } : {}) });
    }
  }
  out.sort((a, b) => Number(b.ok) - Number(a.ok) || b.mates.length - a.mates.length || a.distance - b.distance);
  const fit = ((choice.fit ?? 0) % (out.length || 1) + out.length) % (out.length || 1);
  return [...out.slice(fit), ...out.slice(0, fit)].map((r, i) => ({ ...r, fit: (fit + i) % out.length, fits: out.length, pairs: pair }));
}

// "Snap it": the exact fit nearest where a near-missed part sits now. `row` is a live check's inexact finding
// ({ keys: [a, b] }); the part placed later (the higher key) is the one moved, unless `move` names one. → the try
// (its `parts` hold the moved part, its `op` the attach) or null when no clear fit lies within `reach` LDU.
export function snapIt(model, row, ctx, { move = null, reach = 6 } = {}) {
  const { T, geom } = ctx, byKey = new Map(model.parts.map((p) => [p.key, p]));
  const key = move ?? Math.max(...row.keys), other = row.keys.find((k) => k !== key);
  const p = byKey.get(key), q = byKey.get(other), at = p && !p.flex && poseOf(p, T, geom);
  if (!at || !q) return null;
  const index = ctx.index ?? attachIndex(model.parts, T, geom, ctx.names);
  const otherName = index.byKey.get(other);
  let near = null;
  for (const c of T.stems.get(at.stem).conns) {
    const t = compose(at.pose, c.frame).t;
    for (const e of index.hash.near(t, 1)) {
      if (e.name !== otherName || !compatible(e.conn, c)) continue;
      const d = distance(e.pose.t, t);
      if (d <= reach && (!near || d < near.d)) near = { d, e };
    }
  }
  if (!near) return null;
  const point = { x: near.e.pose.t[0] / 20, y: -near.e.pose.t[1] / 8, z: -near.e.pose.t[2] / 20 };
  const tries = attachTries({ parts: [p], anchor: 0, moving: new Set([p]) }, { part: q, point }, { ...ctx, model, index }, { target: `${otherName}.${address(near.e.conn)}` });
  const gap = (r) => { const b = poseOf(r.parts[0], T, geom); return b ? distance(b.pose.t, at.pose.t) + 20 * Math.max(...b.pose.r.map((v, i) => Math.abs(v - at.pose.r[i]))) : Infinity; };
  const best = tries.filter((r) => r.ok).map((r) => [gap(r), r]).sort((a, b) => a[0] - b[0])[0];
  return best && best[0] <= reach ? { ...best[1], fit: 0, fits: 1 } : null;
}
