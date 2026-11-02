// Basic rectangular parts, keyed by LDraw part number. `w` is the long side,
// which lies along LDraw X at rotation 0; `d` lies along Z. `h` is in plates
// (a brick is three plates tall).

export const BRICKS = [
  { id: '3007', name: 'Brick 2 × 8', w: 8, d: 2, h: 3 },
  { id: '2456', name: 'Brick 2 × 6', w: 6, d: 2, h: 3 },
  { id: '3001', name: 'Brick 2 × 4', w: 4, d: 2, h: 3 },
  { id: '3002', name: 'Brick 2 × 3', w: 3, d: 2, h: 3 },
  { id: '3003', name: 'Brick 2 × 2', w: 2, d: 2, h: 3 },
  { id: '3008', name: 'Brick 1 × 8', w: 8, d: 1, h: 3 },
  { id: '3009', name: 'Brick 1 × 6', w: 6, d: 1, h: 3 },
  { id: '3010', name: 'Brick 1 × 4', w: 4, d: 1, h: 3 },
  { id: '3622', name: 'Brick 1 × 3', w: 3, d: 1, h: 3 },
  { id: '3004', name: 'Brick 1 × 2', w: 2, d: 1, h: 3 },
  { id: '3005', name: 'Brick 1 × 1', w: 1, d: 1, h: 3 },
];

export const PLATES = [
  { id: '3034', name: 'Plate 2 × 8', w: 8, d: 2, h: 1 },
  { id: '3795', name: 'Plate 2 × 6', w: 6, d: 2, h: 1 },
  { id: '3020', name: 'Plate 2 × 4', w: 4, d: 2, h: 1 },
  { id: '3021', name: 'Plate 2 × 3', w: 3, d: 2, h: 1 },
  { id: '3022', name: 'Plate 2 × 2', w: 2, d: 2, h: 1 },
  { id: '3460', name: 'Plate 1 × 8', w: 8, d: 1, h: 1 },
  { id: '3666', name: 'Plate 1 × 6', w: 6, d: 1, h: 1 },
  { id: '3710', name: 'Plate 1 × 4', w: 4, d: 1, h: 1 },
  { id: '3623', name: 'Plate 1 × 3', w: 3, d: 1, h: 1 },
  { id: '3023', name: 'Plate 1 × 2', w: 2, d: 1, h: 1 },
  { id: '3024', name: 'Plate 1 × 1', w: 1, d: 1, h: 1 },
];

// Smooth tiles: no studs on top. Paved surfaces and flat roofs.
export const TILES = [
  { id: '87079', name: 'Tile 2 × 4', w: 4, d: 2, h: 1, studs: false },
  { id: '26603', name: 'Tile 2 × 3', w: 3, d: 2, h: 1, studs: false },
  { id: '3068b', name: 'Tile 2 × 2', w: 2, d: 2, h: 1, studs: false },
  { id: '4162', name: 'Tile 1 × 8', w: 8, d: 1, h: 1, studs: false },
  { id: '6636', name: 'Tile 1 × 6', w: 6, d: 1, h: 1, studs: false },
  { id: '2431', name: 'Tile 1 × 4', w: 4, d: 1, h: 1, studs: false },
  { id: '63864', name: 'Tile 1 × 3', w: 3, d: 1, h: 1, studs: false },
  { id: '3069b', name: 'Tile 1 × 2', w: 2, d: 1, h: 1, studs: false },
  { id: '3070b', name: 'Tile 1 × 1', w: 1, d: 1, h: 1, studs: false },
];

// Transparent bricks for glass: single-stud-wide runs, as in a real facade.
// The 1 × 2 / 1 × 4 / 1 × 6 are the "without bottom tube" bricks LEGO makes
// in transparent colours.
export const GLASS_BRICKS = [
  { id: '3067', name: 'Brick 1 × 6 without Bottom Tubes', w: 6, d: 1, h: 3 },
  { id: '3066', name: 'Brick 1 × 4 without Bottom Tubes', w: 4, d: 1, h: 3 },
  { id: '3065', name: 'Brick 1 × 2 without Bottom Tube', w: 2, d: 1, h: 3 },
  { id: '3005', name: 'Brick 1 × 1', w: 1, d: 1, h: 3 },
];

// Shaped and decorative elements placed by the designer pass. `shape` tells
// the viewer how to draw it; `studs: false` means nothing can attach on top.
// Footprint (w × d) is what it occupies for connections; `vw`/`vd` is how
// wide it looks (a tree top is 4 × 4 on a single 1 × 1 trunk).
export const ELEMENTS = [
  { id: '54200', name: 'Slope 30 1 × 1 × 2/3 (cheese)', w: 1, d: 1, h: 2, studs: false, shape: 'slope' },
  // 45° slopes, a row of studs on the high side (lib/finish.mjs). Their
  // LDraw origin is on that stud, half a stud off the middle (`ldOffset`, LDU
  // along the part's own z).
  { id: '3040b', name: 'Slope 45 2 × 1', w: 1, d: 2, h: 3, shape: 'slope', ldOffset: 10 },
  { id: '3039', name: 'Slope 45 2 × 2', w: 2, d: 2, h: 3, shape: 'slope', ldOffset: 10 },
  // Curved slopes, two plates tall, no studs: a top edge rounded off where nothing stands on it
  // (lib/finish.mjs, on a plate of their size).
  { id: '11477', name: 'Slope Curved 2 × 1', w: 1, d: 2, h: 2, studs: false, shape: 'slope' },
  { id: '15068', name: 'Slope Curved 2 × 2', w: 2, d: 2, h: 2, studs: false, shape: 'slope' },
  { id: '3062b', name: 'Brick Round 1 × 1', w: 1, d: 1, h: 3, shape: 'round' },
  { id: '4073', name: 'Plate Round 1 × 1', w: 1, d: 1, h: 1, shape: 'round' },
  { id: '98138', name: 'Tile Round 1 × 1', w: 1, d: 1, h: 1, studs: false, shape: 'round' },
  { id: '2412b', name: 'Tile 1 × 2 Grille', w: 2, d: 1, h: 1, studs: false },
  { id: '3633', name: 'Fence 1 × 4 × 1', w: 4, d: 1, h: 3, studs: false, shape: 'fence' },
  { id: '3470', name: 'Plant Tree Fruit 4 × 4 × 4 2/3', w: 1, d: 1, h: 14, vw: 4, vd: 4, studs: false, shape: 'tree-round' },
  { id: '3471', name: 'Plant Tree Pine Large 4 × 4 × 6 2/3', w: 1, d: 1, h: 20, vw: 4, vd: 4, studs: false, shape: 'tree-pine' },
  { id: '6064b', name: 'Plant Bush 2 × 2 × 4', w: 1, d: 1, h: 12, vw: 2, vd: 2, studs: false, shape: 'bush' },
  { id: '32607', name: 'Plant Plate Round 1 × 1 with 3 Leaves', w: 1, d: 1, h: 1, studs: false, shape: 'leaves' },
  // Doors and windows (lib/house.mjs). A frame is one part in the wall; the
  // door leaf and the glass are parts of their own that sit in it.
  { id: '60596', name: 'Door 1 × 4 × 6 Frame', w: 4, d: 1, h: 18 },
  { id: '60623', name: 'Door 1 × 4 × 6 with 4 Panes and Stud Handle', w: 4, d: 1, h: 18, studs: false },
  { id: '60594', name: 'Window 1 × 4 × 3 without Shutter Tabs', w: 4, d: 1, h: 9 },
  { id: '60603', name: 'Glass for Window 1 × 4 × 3 Opening', w: 4, d: 1, h: 9, studs: false },
  { id: '60592', name: 'Window 1 × 2 × 2 without Sill', w: 2, d: 1, h: 6 },
  { id: '60601', name: 'Glass for Window 1 × 2 × 2 without Sill', w: 2, d: 1, h: 6, studs: false },
  { id: '33291', name: 'Plate Round 1 × 1 with Flower Edge', w: 1, d: 1, h: 1, studs: false, shape: 'flower' },
];

// Bricks with studs on one side, for building sideways (a picture standing
// studs out, lib/display.mjs). `side`: which ways those studs point at
// rotation 0 (unit directions; +z is the side away from the brick's middle
// at z = +d/2), as ldraw/sidestuds.json has them.
export const SIDE_BRICKS = [
  { id: '30414', name: 'Brick 1 × 4 with 4 Studs on One Side', w: 4, d: 1, h: 3, side: [[0, 0, 1]] },
  { id: '11211', name: 'Brick 1 × 2 with 2 Studs on 1 Side', w: 2, d: 1, h: 3, side: [[0, 0, 1]] },
  { id: '87087', name: 'Brick 1 × 1 with Stud on 1 Side', w: 1, d: 1, h: 3, side: [[0, 0, 1]] },
];

// Parts LDraw has replaced because the old file's geometry was wrong. The
// new part has the same origin and size, so a saved model or an opened
// LDraw file that names the old number just takes the new one.
export const REPLACED = { 3815: '3815b', 4485: '4485b', 6064: '6064b' };
export const currentPart = (id) => REPLACED[id] ?? id;

// Light bricks: never chosen by the cutter, only placed where a script asks for one (lib/script.mjs light).
// 62930 is the 2 × 3 one with a yellow LED that lights when its top is pressed; it is 1 1/3 bricks tall.
export const LIGHT_BRICKS = [
  { id: '62930', name: 'Light Brick 2 × 3 × 1 1/3 [Yellow LED]', w: 3, d: 2, h: 4 },
];

export const CATALOG = new Map([...BRICKS, ...PLATES, ...TILES, ...GLASS_BRICKS, ...ELEMENTS, ...SIDE_BRICKS, ...LIGHT_BRICKS].map((p) => [p.id, p]));

// Every placement option: a part plus the footprint it occupies on the grid.
export function orientations(parts) {
  const out = [];
  for (const p of parts) {
    out.push({ part: p, fx: p.w, fz: p.d, rotation: 0 });
    if (p.w !== p.d) out.push({ part: p, fx: p.d, fz: p.w, rotation: 90 });
  }
  return out;
}
