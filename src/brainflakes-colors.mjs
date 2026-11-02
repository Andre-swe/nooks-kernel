// The colours standard Brain Flakes discs are sold in, and the standard sets.
// Researched 2026-10-26 from the manufacturer's listing of its 500-piece jar
// (brainflakes.com) and a retailer listing of the same jar (michaels.com).
// Hex values are APPROXIMATE visual estimates for on-screen display, not
// measured or published colour values.
//
// Not included, because no manufacturer listing could be confirmed:
// glow-in-the-dark, neon, pastel and metallic discs (none found), and grey
// (mentioned only in a third-hand summary of single-colour refills).
export const COLOR_SOURCE = Object.freeze({
  checked: '2026-10-26',
  sources: ['https://www.brainflakes.com/ (500-piece jar listing: 12 colours, evenly mixed)', 'https://www.michaels.com/ (retail listing of the same jar)'],
  hex: 'approximate',
  omitted: ['glow-in-the-dark', 'neon', 'pastel', 'metallic', 'grey'],
});
export const COLOUR_SOURCE = COLOR_SOURCE;

export const DISC_COLOR_LIST = Object.freeze([
  ['red', 'Red', '#d7263d'],
  ['orange', 'Orange', '#f7801e'],
  ['yellow', 'Yellow', '#ffd21f'],
  ['light-green', 'Light green', '#8cd13f'],
  ['dark-green', 'Dark green', '#1e7f3a'],
  ['light-blue', 'Light blue', '#4fb3e8'],
  ['dark-blue', 'Dark blue', '#1f3f99'],
  ['purple', 'Purple', '#7b3fa0'],
  ['pink', 'Pink', '#f06eaa'],
  ['brown', 'Brown', '#7a4a2a'],
  ['white', 'White', '#f5f5f5'],
  ['black', 'Black', '#1a1a1a'],
].map(([id, name, hex]) => Object.freeze({ id, name, hex, approximate: true })));

export const DISC_COLORS = Object.freeze(Object.fromEntries(DISC_COLOR_LIST.map(c => [c.id, c.hex])));
export const colorName = (c) => DISC_COLOR_LIST.find(x => x.id === c || x.hex === String(c).toLowerCase())?.name ?? String(c);
export const colorHex = (c) => DISC_COLORS[c] ?? (/^#[0-9a-f]{6}$/i.test(c) ? c : '#cccccc');

// Standard sets. Only the 500-piece jar has a confirmed colour mix: "500+"
// discs, evenly mixed across the 12 colours. Per-colour counts below are the
// even split (41 or 42 each, the extra 8 going to the first colours in list
// order); they are an estimate of an even mix, not a published packing list.
// The 1000-piece storage-box set is listed as "multiple colors" without a
// breakdown, so it has no colour mix here.
const even = (total) => Object.fromEntries(DISC_COLOR_LIST.map((c, i) => [c.id, Math.floor(total / 12) + (i < total % 12 ? 1 : 0)]));
export const STANDARD_SETS = Object.freeze({
  'jar-500': Object.freeze({ id: 'jar-500', name: '500-piece jar', discs: 500, mix: 'evenly mixed, 12 colours (manufacturer)', inventory: Object.freeze(even(500)), inventoryBasis: 'even split of the stated count' }),
  'box-1000': Object.freeze({ id: 'box-1000', name: '1000-piece storage box', discs: 1000, mix: 'multiple colours (no breakdown published; count from a retailer listing, not confirmed by the manufacturer)', inventory: null, inventoryBasis: 'unknown' }),
});
