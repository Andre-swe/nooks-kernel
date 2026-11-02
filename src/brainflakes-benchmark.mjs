// Brain Flakes benchmark tasks and pure evaluator, mirroring lib/benchmark.mjs.
// Pure: no DOM, no three.js, no network. Given the same model and task (or
// constraints), evaluateBrainflakes returns the same result.
import { SYSTEM, MAX_DISCS } from './brainflakes.mjs';
import { DISC_COLOR_LIST, DISC_COLORS, STANDARD_SETS, colorName } from './brainflakes-colors.mjs';
import { checkBrainflakes, runBrainflakesProgram } from './brainflakes-program.mjs';
import { apply } from './pose.mjs';
import { checkBrainflakesSymmetry } from './brainflakes-inspect.mjs';

export const BRAINFLAKES_EVALUATOR = 'nooks-brainflakes-bench-v1';

export const BRAINFLAKES_NOT_VERIFIED = Object.freeze([
  { id: 'physical', label: 'Physical retention and strength', detail: 'Not verified. Press-fit is a geometric finding within the measured slot narrowing (~0.05 mm per wall). Elastic deformation, insertion force, retention and structural sag are not simulated.' },
  { id: 'assembly', label: 'Assembly by hand', detail: 'Not verified. Reach, flex clearance and step order are not simulated.' },
  { id: 'visual', label: 'Visual quality and resemblance', detail: 'Not scored by software. Whether the build reads as its subject is a human or separate visual judgement.' },
]);

export function dimensionsOfBrainflakes(model, def) {
  const discs = model?.discs ?? [];
  if (!discs.length) return { length: 0, width: 0, height: 0 };
  const bounds = def?.measurements?.bounds ?? { min:[-16.2,-16.2,0], max:[16.2,16.2,2.5] };
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const d of discs) for (let i=0;i<8;i++) {
    const p = apply(d.pose, [0,1,2].map(a => bounds[(i & (1 << a)) ? 'max' : 'min'][a]));
    for (let a=0;a<3;a++) { lo[a]=Math.min(lo[a],p[a]); hi[a]=Math.max(hi[a],p[a]); }
  }
  return { length: Math.round((hi[0] - lo[0]) * 10) / 10, width: Math.round((hi[1] - lo[1]) * 10) / 10, height: Math.round((hi[2] - lo[2]) * 10) / 10 };
}

export function normaliseBrainflakesConstraints(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Provide Brain Flakes task constraints.');
  const maxDiscs = value.maxDiscs ?? value.maxPieces ?? MAX_DISCS;
  const minDiscs = value.minDiscs ?? value.minPieces ?? 1;
  if (!Number.isInteger(maxDiscs) || maxDiscs < 1 || maxDiscs > MAX_DISCS) throw new Error(`maxDiscs must be a whole number from 1 to ${MAX_DISCS}.`);
  if (!Number.isInteger(minDiscs) || minDiscs < 1 || minDiscs > maxDiscs) throw new Error('minDiscs must be between 1 and maxDiscs.');
  const out = { minDiscs, maxDiscs, requireConnected: value.requireConnected !== false, minConnections: value.minConnections ?? Math.max(0, minDiscs - 1), minLoops: value.minLoops ?? 0, minColors: value.minColors ?? 1 };
  if (value.set) {
    if (!STANDARD_SETS[value.set]) throw new Error(`Unknown standard set: ${value.set}.`);
    out.set = value.set;
  }
  if (value.allowedColours) {
    if (!Array.isArray(value.allowedColours) || !value.allowedColours.length) throw new Error('allowedColours must be a non-empty list of Brain Flakes colours.');
    for (const c of value.allowedColours) if (!Object.hasOwn(DISC_COLORS, c)) throw new Error(`Unknown Brain Flakes colour: ${c}.`);
    out.allowedColours = [...new Set(value.allowedColours)];
  }
  if (value.minHeightMm !== undefined) out.minHeightMm = Number(value.minHeightMm);
  if (value.maxDimensionsMm !== undefined) out.maxDimensionsMm = value.maxDimensionsMm.map(Number);
  if (value.symmetry !== undefined) {
    const s=value.symmetry;
    if(!s || !['x','y','z'].includes(s.axis) || !Number.isFinite(s.coordinate) || (s.tolerance !== undefined && (!Number.isFinite(s.tolerance) || s.tolerance<=0 || s.tolerance>2))) throw new Error('symmetry requires axis, coordinate and optional tolerance in mm.');
    out.symmetry={axis:s.axis,coordinate:s.coordinate,tolerance:s.tolerance ?? 0.1,colors:s.colors !== false};
  }
  return out;
}

export function evaluateBrainflakes(model, def, constraints = {}, { collisions = null } = {}) {
  if (model?.system !== SYSTEM) throw new Error('Expected a Brain Flakes assembly.');
  const c = normaliseBrainflakesConstraints(constraints);
  const report = checkBrainflakes(model, def, { set: c.set ?? null, inventory:model.inventory ?? null, maxParts: c.maxDiscs, collisions });
  const dims = dimensionsOfBrainflakes(model, def);
  const checks = [];
  const add = (id, label, passed, detail, parts = []) => checks.push({ id, label, passed: !!passed, detail, parts: passed ? [] : parts.slice(0, 100) });
  const n = model.discs.length, m = model.connections.length;
  if (c.symmetry) {
    const s=checkBrainflakesSymmetry(model,def,c.symmetry);
    add('symmetry','Requested reflected disc symmetry',s.passed,s.passed ? 'Disc centers, plane normals and selected colors match.' : `No reflected match for: ${s.unmatched.join(', ')}`,s.unmatched);
  }
  if (c.requireConnected) {
    const ok = n > 0 && report.floating.length === 0 && report.inexact.length === 0;
    add('connected', 'One connected assembly', ok,
      !n ? 'No discs placed'
        : report.inexact.length ? `${report.inexact.length} connection(s) whose slots do not line up`
          : report.floating.length ? `${report.floating.length} disc(s) not connected to the main build`
            : `One connected assembly (${m} slot connection${m === 1 ? '' : 's'})`,
      [...report.floating, ...report.inexact.flatMap((e) => [e.a.id, e.b.id])]);
  }
  add('discs', 'Disc budget', n >= c.minDiscs && n <= c.maxDiscs, `${n} discs; allowed ${c.minDiscs} to ${c.maxDiscs}`);
  const loops = Math.max(0, m - Math.max(0, n - 1));
  if (c.minLoops > 0) add('loops', 'Closed loops', loops >= c.minLoops, `${loops} closed loop(s); at least ${c.minLoops} required`);
  const usedColors = Object.keys(report.colors);
  const badCat = model.discs.filter((d) => !Object.hasOwn(DISC_COLORS, d.color)).map((d) => d.id);
  const disallowed = c.allowedColours ? model.discs.filter((d) => !c.allowedColours.includes(d.color)).map((d) => d.id) : [];
  const colorOk = !badCat.length && !disallowed.length && usedColors.length >= c.minColors;
  add('palette', 'Colours', colorOk,
    badCat.length ? 'Uses colours outside the Brain Flakes catalogue'
      : disallowed.length ? `Uses colours not allowed by task: ${[...new Set(disallowed.map((id) => model.discs.find((d) => d.id === id)?.color))].join(', ')}`
        : `${usedColors.length} colour(s) (${usedColors.map(colorName).join(', ')}), minimum ${c.minColors}`,
    [...badCat, ...disallowed]);
  if (c.set) {
    const setInfo = STANDARD_SETS[c.set];
    const over = report.over.filter((o) => o.color);
    add('inventory', `Estimated set inventory (${setInfo.name})`, !over.length && n <= setInfo.discs,
      over.length ? `Over set mix: ${over.map((o) => `${o.need} ${o.color} (${o.have} in set)`).join(', ')}`
        : `Within estimated ${setInfo.name} allocation (${n}/${setInfo.discs} discs); colour counts are not a verified packing list`);
  }
  if (c.minHeightMm !== undefined) {
    const span = Math.max(dims.length, dims.width, dims.height);
    add('reach', 'Minimum span / height', span >= c.minHeightMm, `Largest span ${span} mm; at least ${c.minHeightMm} mm`);
  }
  if (c.maxDimensionsMm) {
    const have = [dims.length, dims.width, dims.height];
    const ok = have.every((v, i) => v <= c.maxDimensionsMm[i]);
    add('size', 'Size bounds', ok, `${have.join(' × ')} mm; at most ${c.maxDimensionsMm.join(' × ')} mm`);
  }
  add('overlap', 'No unintended disc collision', report.collisions.length === 0,
    report.collisions.length ? `${report.collisions.length} unintended overlap(s) (${report.collisionMethod})`
      : `No unintended overlaps (${report.collisionMethod}; connected slots are designed press-fit)`,
    [...new Set(report.collisions.flatMap((x) => [x.a, x.b]))]);
  const passedCount = checks.filter((x) => x.passed).length;
  return {
    system: SYSTEM,
    evaluator: BRAINFLAKES_EVALUATOR,
    constraints: c,
    score: checks.length ? Math.round((passedCount / checks.length) * 100) : 100,
    scoreMeaning: 'Specified software constraints only; not semantic resemblance or design quality.',
    design: { status:'not-evaluated', reason:'No independent visual or semantic judge was run.' },
    software: { passed: checks.every((x) => x.passed), checks },
    notVerified: BRAINFLAKES_NOT_VERIFIED,
    pieces: n,
    discs: n,
    connections: m,
    loops,
    dimensions: dims,
    check: report,
  };
}

export const BRAINFLAKES_BENCHMARKS = Object.freeze([
  Object.freeze({
    id: 'bf-flower',
    title: 'Brain Flakes flower with stem',
    prompt: 'Build a Brain Flakes flower with a yellow centre, eight pink or purple petals around it, and a green stem of at least three discs.',
    constraints: Object.freeze({ minDiscs: 12, maxDiscs: 36, minColors: 3, allowedColours: ['yellow', 'pink', 'purple', 'light-green', 'dark-green'] }),
    referenceProgram: Object.freeze({
      system: SYSTEM, name: 'Flower with stem',
      ops: [
        { op: 'disc', name: 'centre', color: 'yellow' },
        { op: 'ring', prefix: 'petal', color: 'pink', to: 'centre', slots: [0, 1, 2, 3, 5, 6, 7], by: 0, pose: 0 },
        { op: 'attach', name: 'stem1', color: 'light-green', to: 'centre.slot[4]', by: 0, pose: 0 },
        { op: 'attach', name: 'stem2', color: 'dark-green', to: 'stem1.slot[4]', by: 0, pose: 0 },
        { op: 'attach', name: 'stem3', color: 'light-green', to: 'stem2.slot[4]', by: 0, pose: 0 },
        { op: 'attach', name: 'leafL', color: 'dark-green', to: 'stem2.slot[2]', by: 0, pose: 1 },
        { op: 'attach', name: 'leafR', color: 'dark-green', to: 'stem2.slot[6]', by: 0, pose: 1 },
      ],
    }),
  }),
  Object.freeze({
    id: 'bf-ball',
    title: 'Brain Flakes cage ball',
    prompt: 'Build a rounded Brain Flakes ball or lantern cage with ribs around a core and at least two ribs branching out.',
    constraints: Object.freeze({ minDiscs: 14, maxDiscs: 48, minColors: 2 }),
    referenceProgram: Object.freeze({
      system: SYSTEM, name: 'Cage ball',
      ops: [
        { op: 'disc', name: 'hub', color: 'yellow' },
        { op: 'ring', prefix: 'rib', color: 'light-blue', to: 'hub', slots: [0, 1, 2, 3, 4, 5, 6, 7], by: 0, pose: 0 },
        { op: 'attach', name: 'cap1', color: 'orange', to: 'rib1.slot[4]', by: 0, pose: 0 },
        { op: 'attach', name: 'cap2', color: 'orange', to: 'rib3.slot[4]', by: 0, pose: 0 },
        { op: 'attach', name: 'cap3', color: 'orange', to: 'rib5.slot[4]', by: 0, pose: 0 },
        { op: 'attach', name: 'cap4', color: 'orange', to: 'rib7.slot[4]', by: 0, pose: 0 },
        { op: 'attach', name: 'fin1', color: 'red', to: 'cap1.slot[2]', by: 0, pose: 1 },
        { op: 'attach', name: 'fin2', color: 'red', to: 'cap3.slot[2]', by: 0, pose: 1 },
        { op: 'close' },
      ],
    }),
  }),
  Object.freeze({
    id: 'bf-tower',
    title: 'Brain Flakes tower',
    prompt: 'Build a Brain Flakes tower with a four-footed base and a spine reaching at least 140 mm along its long axis.',
    constraints: Object.freeze({ minDiscs: 12, maxDiscs: 45, minHeightMm: 140, minColors: 2 }),
    referenceProgram: Object.freeze({
      system: SYSTEM, name: 'Spire tower',
      ops: [
        { op: 'disc', name: 'base', color: 'dark-blue' },
        { op: 'ring', prefix: 'foot', color: 'light-blue', to: 'base', slots: [1, 3, 5, 7], by: 0, pose: 0 },
        { op: 'attach', name: 's1', color: 'white', to: 'base.slot[0]', by: 0, pose: 0 },
        { op: 'attach', name: 's2', color: 'red', to: 's1.slot[4]', by: 0, pose: 0 },
        { op: 'attach', name: 's3', color: 'white', to: 's2.slot[4]', by: 0, pose: 0 },
        { op: 'attach', name: 's4', color: 'red', to: 's3.slot[4]', by: 0, pose: 0 },
        { op: 'attach', name: 's5', color: 'white', to: 's4.slot[4]', by: 0, pose: 0 },
        { op: 'attach', name: 's6', color: 'red', to: 's5.slot[4]', by: 0, pose: 0 },
        { op: 'attach', name: 's7', color: 'yellow', to: 's6.slot[4]', by: 0, pose: 0 },
        { op: 'attach', name: 'finL', color: 'yellow', to: 's6.slot[2]', by: 0, pose: 1 },
        { op: 'attach', name: 'finR', color: 'yellow', to: 's6.slot[6]', by: 0, pose: 1 },
      ],
    }),
  }),
  Object.freeze({
    id: 'bf-animal',
    title: 'Brain Flakes turtle',
    prompt: 'Build a small Brain Flakes animal (such as a turtle or beetle) with a body, head, tail and four legs.',
    constraints: Object.freeze({ minDiscs: 10, maxDiscs: 36, minColors: 2 }),
    referenceProgram: Object.freeze({
      system: SYSTEM, name: 'Turtle',
      ops: [
        { op: 'disc', name: 'belly', color: 'light-green' },
        { op: 'attach', name: 'head', color: 'dark-green', to: 'belly.slot[0]', by: 0, pose: 0 },
        { op: 'attach', name: 'tail', color: 'dark-green', to: 'belly.slot[4]', by: 0, pose: 0 },
        { op: 'ring', prefix: 'leg', color: 'brown', to: 'belly', slots: [1, 3, 5, 7], by: 0, pose: 0 },
        { op: 'attach', name: 'ridgeL', color: 'dark-green', to: 'belly.slot[2]', by: 0, pose: 1 },
        { op: 'attach', name: 'ridgeR', color: 'dark-green', to: 'belly.slot[6]', by: 0, pose: 1 },
        { op: 'attach', name: 'crest1', color: 'yellow', to: 'ridgeL.slot[4]', by: 0, pose: 0 },
        { op: 'attach', name: 'crest2', color: 'yellow', to: 'ridgeR.slot[4]', by: 0, pose: 0 },
      ],
    }),
  }),
  Object.freeze({
    id: 'bf-tub-starburst',
    title: 'Standard 500-piece jar starburst pavilion',
    prompt: 'Using only discs available in one standard 500-piece jar (jar-500), build a 30+ disc starburst pavilion.',
    constraints: Object.freeze({ minDiscs: 30, maxDiscs: 60, set: 'jar-500', minColors: 4 }),
    referenceProgram: Object.freeze({
      system: SYSTEM, name: 'Jar starburst pavilion', set: 'jar-500',
      ops: [
        { op: 'disc', name: 'core', color: 'yellow' },
        // Four radial branches avoid the coplanar overlap between neighboring
        // extensions of the old eight-arm candidate (retained as a regression).
        { op: 'ring', prefix: 'arm', color: 'orange', to: 'core', slots: [0, 2, 4, 6], by: 0, pose: 0 },
        ...Array.from({length:4}, (_,a) => Array.from({length:7}, (_,k) => ({
          op:'attach', name:`branch${a+1}-${k+1}`, color:['red','purple','light-blue','pink'][a],
          to:`${k ? `branch${a+1}-${k}` : `arm${a+1}`}.slot[4]`, by:0, pose:0,
        }))).flat(),
      ],
    }),
  }),
]);

export function runBrainflakesBenchmark(taskId, programOrModel, def, { collisions = null } = {}) {
  const task = BRAINFLAKES_BENCHMARKS.find((t) => t.id === taskId);
  if (!task) throw new Error(`Unknown Brain Flakes benchmark: ${taskId}.`);
  const model = programOrModel?.ops ? runBrainflakesProgram(programOrModel, def, { maxDiscs: task.constraints.maxDiscs }).model : programOrModel;
  return { task: { id: task.id, title: task.title, prompt: task.prompt }, ...evaluateBrainflakes(model, def, task.constraints, { collisions }) };
}
