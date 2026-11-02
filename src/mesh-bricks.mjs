// A 3D model filled with bricks, as a starting point to edit (the workbench's File → Fill with bricks, and the
// MCP tool import_3d with fill): the mesh is voxelised at a width in studs (lib/mesh.mjs), the cells cut into
// real bricks (lib/decompose.mjs), slopes put on single-stud steps of the top surface (lib/finish.mjs), and the
// build repaired until every part is held (lib/validate.mjs). The model it gives is marked as made from a 3D
// model by rule, not designed. Pure: no DOM, no network.
import { voxelizeMesh } from './mesh.mjs';
import { decompose, repair, bridgeByRecolour, stitch } from './decompose.mjs';
import { validate } from './validate.mjs';
import { planSlopes, addSlopes } from './finish.mjs';
import { toModel } from './export.mjs';

function build(vox, { name, source, fillColor = 71 }, diagonal) {
  const t0 = Date.now(), full = vox;
  const finish = planSlopes(vox, { brick: () => true, diagonal });
  vox = finish.vox;
  const rebuild = () => decompose(vox, { kind: 'brick', fillColor, layerKinds: null, topDown: false });
  let result = repair(vox, rebuild(), validate, { single: false, rounds: 4 });
  // Stitching re-cuts hidden or same-colour parts (nothing you can see changes); recolouring a stud is the last resort.
  let stitched = 0, recoloured = 0;
  if (validate(result).floating.length) ({ result, stitched } = stitch(vox, result));
  if (validate(result).floating.length) {
    const bridged = bridgeByRecolour(vox, result, validate, rebuild);
    result = bridged.result; recoloured = bridged.recoloured;
    if (validate(result).floating.length) ({ result } = stitch(vox, result));
  }
  if (finish.slopes.length) result = addSlopes(result, finish.slopes, { bottomOf: (y) => y * 3 });
  const validation = { ...validate(result), recoloured, stitched, slopes: finish.slopes.length };
  const model = toModel(result, validation, { name, mode: 'mesh', source });
  if (finish.slopes.length) model.provenance.finishing = { slopes: finish.slopes.length, rule: 'top-surface steps of one stud as 45° slopes (3040b, 3039)', evidence: 'rule' };
  model.timing = { ms: Date.now() - t0 };
  return { vox: full, result, validation, model };
}

// `mesh`: { positions, indices, colorAt } (lib/mesh-read.mjs), y up. `width`: studs across its widest side;
// `colours`: how many colours at most. → { model, validation }.
export function bricksFromMesh(mesh, { width = 24, colours = 8, name = 'From a 3D model', source = null } = {}) {
  const vox = voxelizeMesh(mesh, { width: Math.max(4, Math.min(64, Math.round(width))), maxColors: Math.max(2, Math.min(16, colours)) });
  const src = { kind: '3d-model', ...(source ?? {}), evidence: 'filled with bricks by rule from the 3D model, not designed' };
  // Slopes on real diagonals only; where that leaves a part held by nothing, built again with a slope on every step.
  const built = build(vox, { name, source: src }, true);
  const out = built.validation.floating.length && built.validation.slopes ? build(vox, { name, source: src }, false) : built;
  return { model: out.model, validation: out.validation };
}
