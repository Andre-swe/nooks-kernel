// Which parts can never be seen: walled in on every side (top, bottom and
// all four sides) by solid parts. Such a part need not be drawn once the
// parts that cover it are in place, and drawing nothing there is what lets
// big models run smoothly in the browser. Pure: no DOM.
//
// `coveredAt(model, order)`: for each part in build order, the position in
// that order after which it is hidden (the last of its coverers), or -1 when
// something always shows it. Glass, figures, plants and parts that are not
// full boxes (slopes, round parts) never cover anything.

const footprint = (p) => (p.rotation === 90 || p.rotation === 270 ? [p.d, p.w] : [p.w, p.d]);
const solid = (p) => !p.origin && (p.shape == null || p.shape === 'box' || p.shape === 'tile') && !p.trans;

// Each solid part's cells, on a half-stud grid in x and z (kits sit half a
// stud off the whole-stud grid in places) and per plate in y; and the desk,
// under the model's lowest plate wherever that is (a kit comes a plate up:
// its base is at plate 1, and under it is still the desk).
function grid(order, isTrans) {
  const cell = new Map();                        // cell → order index of the part filling it
  const at = (x, y, z) => ((x + 4096) * 8192 + (y + 4096)) * 8192 + (z + 4096);   // a number, not a string: fast
  const box = order.map((p) => {
    const [fx, fz] = footprint(p);
    return { x0: Math.round((p.x - fx / 2) * 2), z0: Math.round((p.z - fz / 2) * 2), y0: Math.round(p.y), fx: Math.max(1, Math.round(fx * 2)), fz: Math.max(1, Math.round(fz * 2)), h: Math.max(1, Math.round(p.h)) };
  });
  order.forEach((p, i) => {
    if (!solid(p) || isTrans(p.color)) return;
    const b = box[i];
    for (let x = 0; x < b.fx; x++) for (let z = 0; z < b.fz; z++) for (let y = 0; y < b.h; y++) cell.set(at(b.x0 + x, b.y0 + y, b.z0 + z), i);
  });
  let floor = 0;
  if (order.length) { floor = Infinity; for (const b of box) if (b.y0 < floor) floor = b.y0; }
  return { cell, at, box, floor };
}

// Which solid parts sit with their whole underside on solid parts (or the
// desk): 1 for those, 0 for the rest. Their underside (the tubes inside)
// can never be seen, so the viewer can draw them without it. Only what is
// under a part counts.
export function undersidesCovered(order, opts) {
  return Uint8Array.from(undersideCoveredAt(order, opts), (j) => (j >= 0 ? 1 : 0));
}

// The same by build order, as coveredAt: for each part, the position in the
// order after which its underside is covered (the last of the parts under
// it; its own position when it stands on the desk), or -1 when it never is.
// What is under a part is nearly always built before it, but not always (a
// part hung under an overhang): while the build plays, a part is drawn
// without its underside only once this many parts are in place.
export function undersideCoveredAt(order, { isTrans = () => false } = {}) {
  const { cell, at, box, floor } = grid(order, isTrans);
  return Int32Array.from(order, (p, i) => {
    if (!solid(p) || isTrans(p.color)) return -1;
    const b = box[i];
    if (b.y0 - 1 < floor) return i;
    let last = i;
    for (let x = 0; x < b.fx; x++) for (let z = 0; z < b.fz; z++) {
      const j = cell.get(at(b.x0 + x, b.y0 - 1, b.z0 + z));
      if (j === undefined || j === i) return -1;
      if (j > last) last = j;
    }
    return last;
  });
}

export function coveredAt(order, { isTrans = () => false } = {}) {
  const { cell, at, box, floor } = grid(order, isTrans);
  return order.map((p, i) => {
    if (!solid(p)) return -1;
    const b = box[i];
    let last = i;
    const need = (x, y, z) => {
      if (y < floor) return true;                // under the base: the desk hides it
      const j = cell.get(at(x, y, z));
      if (j === undefined || j === i) return false;
      last = Math.max(last, j);
      return true;
    };
    // Top and bottom faces.
    for (let x = 0; x < b.fx; x++) for (let z = 0; z < b.fz; z++) {
      if (!need(b.x0 + x, b.y0 + b.h, b.z0 + z) || !need(b.x0 + x, b.y0 - 1, b.z0 + z)) return -1;
    }
    // Four sides, every plate of the part's height.
    for (let y = 0; y < b.h; y++) {
      for (let x = 0; x < b.fx; x++) if (!need(b.x0 + x, b.y0 + y, b.z0 - 1) || !need(b.x0 + x, b.y0 + y, b.z0 + b.fz)) return -1;
      for (let z = 0; z < b.fz; z++) if (!need(b.x0 - 1, b.y0 + y, b.z0 + z) || !need(b.x0 + b.fx, b.y0 + y, b.z0 + z)) return -1;
    }
    return last;
  });
}
