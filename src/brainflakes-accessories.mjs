// Provisional accessory kinematics, in millimetres. This is not a fit model:
// the real bore, retention and disc-to-axle mechanism have not been measured.
import { ID, compose, move, spin } from './pose.mjs';
import { isRigidPose } from './brainflakes.mjs';

export const ACCESSORY_SPEC = Object.freeze({
  wheel: Object.freeze({ outerDiameterMm: 39.4, overallWidthMm: 12.7, hubBoreDiameterMm: null }),
  axle: Object.freeze({ overallLengthMm: 96, listedWidthMm: 14.75, shaftDiameterMm: null }),
  pack: Object.freeze({ wheels: 16, axles: 8, discs: 0 }),
  calibrationStatus: 'unverified',
});

// A wheel's centre is inset half its width from the nominal axle end. The
// joint is a deliberately provisional revolute connection, not a snap claim.
export function wheelPose(axlePose, side, angleDegrees = 0) {
  if (!isRigidPose(axlePose) || ![-1, 1].includes(side) || !Number.isFinite(angleDegrees)) throw new Error('Invalid axle pose, side or angle.');
  const offset = side * (ACCESSORY_SPEC.axle.overallLengthMm - ACCESSORY_SPEC.wheel.overallWidthMm) / 2;
  return compose(compose(axlePose, move(offset, 0, 0)), spin([1, 0, 0], angleDegrees));
}

// Additive metadata for an existing disc assembly. Callers must explicitly
// opt in; the disc-only checker does not validate these joints or collisions.
export function addWheelPair(model, { axleId, wheelIds, pose = ID } = {}) {
  if (!model || model.system !== 'brainflakes-standard' || !Array.isArray(model.discs) || !Array.isArray(wheelIds) || wheelIds.length !== 2 || !isRigidPose(pose)) throw new Error('Invalid wheel pair.');
  const ids = [axleId, ...wheelIds];
  const used = new Set([...model.discs.map(p => p.id), ...(model.accessories ?? []).map(p => p.id)]);
  if (ids.some(id => typeof id !== 'string' || !id || id.length > 80 || used.has(id)) || new Set(ids).size !== 3) throw new Error('Invalid or duplicate part id.');
  model.accessories ??= [];
  model.joints ??= [];
  model.accessories.push({ id: axleId, type: 'axle', pose: structuredClone(pose) });
  for (const [i, side] of [-1, 1].entries()) {
    model.accessories.push({ id: wheelIds[i], type: 'wheel', pose: wheelPose(pose, side) });
    model.joints.push({ type: 'revolute', parent: axleId, child: wheelIds[i], axis: [1, 0, 0], side, angleDegrees: 0, calibration: 'unverified' });
  }
  model.validation = { status: 'not-run', accessories: 'not-validated' };
}

export function setWheelAngle(model, wheelId, angleDegrees) {
  if (!Number.isFinite(angleDegrees)) throw new Error('Angle must be finite.');
  const joint = model.joints?.find(j => j.type === 'revolute' && j.child === wheelId);
  const wheel = model.accessories?.find(p => p.id === wheelId && p.type === 'wheel');
  const axle = model.accessories?.find(p => p.id === joint?.parent && p.type === 'axle');
  if (!joint || !wheel || !axle || ![-1, 1].includes(joint.side)) throw new Error('Unknown or invalid wheel joint.');
  wheel.pose = wheelPose(axle.pose, joint.side, angleDegrees);
  joint.angleDegrees = angleDegrees;
  model.validation = { status: 'not-run', accessories: 'not-validated' };
}

export function accessoryInventory(model, available = ACCESSORY_SPEC.pack) {
  const counts = { discs: model.discs.length, wheels: 0, axles: 0 };
  for (const p of model.accessories ?? []) {
    if (p.type === 'wheel') counts.wheels++;
    else if (p.type === 'axle') counts.axles++;
    else throw new Error(`Unknown accessory type: ${p.type}`);
  }
  const shortages = Object.keys(counts).filter(k => counts[k] > (available[k] ?? 0)).map(k => ({ type: k, count: counts[k], available: available[k] ?? 0 }));
  return { counts, shortages };
}
