// A part's frame without its geometry: how its LDraw origin sits against the
// seated shape the workbench places by (ldraw/frames.json, made by
// scripts/bundle-frames.mjs exactly as workbench.mjs geometryOf works it
// out). With it, lib/studio.mjs freeForm places any part in millimetres, in
// the page or in Node. Pure: the caller loads the table.
//
// `table`: frames.json's `parts`. Returns { cx, cz, minY, slopeTurn, box }
// (box: [x0, y0, z0, x1, y1, z1] about the LDraw origin), or null.
export function frameOf(id, table) {
  const f = table?.[id];
  if (!f) return null;
  return { cx: f[0], cz: f[1], minY: f[2], slopeTurn: f[3], box: f.slice(4, 10) };
}
// A geometry lookup for freeForm, rotateParts and the like: (id) => frame.
export const framesFrom = (table) => (id) => frameOf(id, table);
