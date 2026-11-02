// A voxel grid in brick units: x and z are studs, y is layers counted from
// the ground. Each cell holds a palette colour code, EMPTY, or WILD.
// WILD marks a hidden interior cell: it must be filled for strength but its
// colour is free, which lets the decomposer use larger parts there.

export const EMPTY = -1;
export const WILD = -2;

export class VoxelGrid {
  constructor(nx, ny, nz) {
    this.nx = nx; this.ny = ny; this.nz = nz;
    this.cells = new Int16Array(nx * ny * nz).fill(EMPTY);
  }
  index(x, y, z) { return (y * this.nz + z) * this.nx + x; }
  inside(x, y, z) {
    return x >= 0 && y >= 0 && z >= 0 && x < this.nx && y < this.ny && z < this.nz;
  }
  get(x, y, z) { return this.inside(x, y, z) ? this.cells[this.index(x, y, z)] : EMPTY; }
  set(x, y, z, v) { this.cells[this.index(x, y, z)] = v; }
  filled(x, y, z) { return this.get(x, y, z) !== EMPTY; }
  count() {
    let n = 0;
    for (const v of this.cells) if (v !== EMPTY) n++;
    return n;
  }
  // A cell is visible when any face touches empty space.
  visible(x, y, z) {
    return !this.filled(x + 1, y, z) || !this.filled(x - 1, y, z) ||
      !this.filled(x, y + 1, z) || !this.filled(x, y - 1, z) ||
      !this.filled(x, y, z + 1) || !this.filled(x, y, z - 1);
  }
  // Turn every hidden coloured cell into WILD.
  hideInterior() {
    const hidden = [];
    for (let y = 0; y < this.ny; y++)
      for (let z = 0; z < this.nz; z++)
        for (let x = 0; x < this.nx; x++)
          if (this.filled(x, y, z) && !this.visible(x, y, z)) hidden.push(this.index(x, y, z));
    for (const i of hidden) this.cells[i] = WILD;
    return hidden.length;
  }
  // Drop empty margins so the model sits at the origin.
  trim() {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -1, y1 = -1, z1 = -1;
    for (let y = 0; y < this.ny; y++)
      for (let z = 0; z < this.nz; z++)
        for (let x = 0; x < this.nx; x++)
          if (this.filled(x, y, z)) {
            x0 = Math.min(x0, x); y0 = Math.min(y0, y); z0 = Math.min(z0, z);
            x1 = Math.max(x1, x); y1 = Math.max(y1, y); z1 = Math.max(z1, z);
          }
    if (x1 < 0) return new VoxelGrid(0, 0, 0);
    const out = new VoxelGrid(x1 - x0 + 1, y1 - y0 + 1, z1 - z0 + 1);
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) out.set(x - x0, y - y0, z - z0, this.get(x, y, z));
    return out;
  }
}
