// Between the workbench's parts and the agent runtime's poses (docs/BUILD_BY_CONNECTOR.md): a part as BrickNet's
// stem and pose, and a pose back as the workbench part, on the grid again when it lands there. Pure: the caller
// passes BrickNet's tables (lib/bricknet.mjs load) and a frame lookup (lib/frames.mjs framesFrom).
//
// The workbench places a part by its LDraw origin O (mm, this app's axes: y up) and rotation M (lib/studio.mjs
// freeForm). LDraw's axes are this app's turned half a turn about x, so a point goes to (x, −y, −z) × 2.5 LDU per
// mm and a rotation to S·M·S, S = diag(1, −1, −1). Our part number then maps to BrickNet's stem through `ours`, an
// alias carrying the transform from our part's frame to the stem's.
import { compose, inverse } from './pose.mjs';
import { freeForm, fromFree } from './studio.mjs';

const LDU_PER_MM = 2.5;
const flipM = ([a, b, c, d, e, f, g, h, k]) => [a, -b, -c, -d, e, f, -g, h, k];
const zero = (v) => (Math.abs(v) < 1e-12 ? 0 : v);

// BrickNet's stem for our part number and the alias transform, or null when BrickNet has no such part.
export function stemOf(T, id) {
  const mapped = T.ours[String(id).toLowerCase()];
  if (!mapped) return null;
  const [stem, m] = Array.isArray(mapped) ? mapped : [mapped, null];
  return T.stems.has(stem) ? { stem, alias: m ? { r: m.slice(3, 12), t: m.slice(0, 3) } : null } : null;
}

// A workbench part as { stem, pose } (LDraw units and axes, the stem's own frame), or null when BrickNet lacks the
// part or the workbench has no frame for it. A flexible part is its stock part at its start, as LDraw writes it.
export function poseOf(part, T, geom) {
  const s = stemOf(T, part.id);
  if (!s) return null;
  const g = part.origin && part.ldMatrix ? null : geom(part.id);
  if (!g && !(part.origin && part.ldMatrix)) return null;
  const { O, M } = freeForm(part, g);
  const ld = { r: flipM(M).map(zero), t: [O[0], -O[1], -O[2]].map((v) => zero(v * LDU_PER_MM)) };
  return { stem: s.stem, pose: s.alias ? compose(ld, s.alias) : ld };
}

// The workbench part (a copy of `part`, its id and colour kept) that puts the part at `pose`, BrickNet's frame for
// the part's stem. On the grid again when the pose is upright and a quarter turn; otherwise on its own matrix.
export function partFromPose(part, pose, T, geom) {
  const s = stemOf(T, part.id);
  if (!s) throw new Error(`BrickNet has no part ${part.id}.`);
  const ld = s.alias ? compose(pose, inverse(s.alias)) : pose;
  const O = [ld.t[0], -ld.t[1], -ld.t[2]].map((v) => zero(v / LDU_PER_MM));
  const out = fromFree(part, O, flipM(ld.r).map(zero), geom(part.id) ?? { cx: 0, cz: 0, minY: 0 });
  // fromFree rounds to 1e-4 of a stud, which suits the grid; a part on its own matrix keeps its exact origin.
  if (out.origin) Object.assign(out, { x: O[0] / 8, y: O[1] / 3.2, z: O[2] / 8 });
  return out;
}
