// Structural check. Two parts are connected when they sit in adjacent layers
// and share at least one stud position. Parts in the same layer never hold
// each other. A part is "floating" when no chain of connections reaches the
// ground layer; it is "weak" when its whole hold on the model is one stud.

export function validate({ parts, owners, nx, nz }) {
  const n = parts.length;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const studs = new Map();
  const held = new Float64Array(n);
  for (let y = 1; y < owners.length; y++) {
    const up = owners[y], down = owners[y - 1];
    for (let i = 0; i < nx * nz; i++) {
      const a = up[i], b = down[i];
      if (a < 0 || b < 0 || a === b) continue;
      // Tiles, slopes and plant tops have no studs: nothing above them is held.
      if (parts[b].studs === false) continue;
      union(a, b);
      held[a]++; held[b]++;
      const k = a * n + b;
      studs.set(k, (studs.get(k) || 0) + 1);
    }
  }
  // A part that sits on another and only on it (a curved slope on its plate) is held by it.
  for (const p of parts) if (p.heldBy !== undefined && parts[p.heldBy]) union(p.key, p.heldBy);
  const groundRoots = new Set(parts.filter((p) => p.layer === 0).map((p) => find(p.key)));
  // An inset part (a door leaf, a pane of glass) sits in its frame and is held by it.
  const roots = new Set(parts.filter((p) => !p.inset).map((p) => find(p.key)));
  const floating = parts.filter((p) => !p.inset && !groundRoots.has(find(p.key))).map((p) => p.key);
  const weak = n > 1 ? parts.filter((p) => !p.inset && held[p.key] === 1).map((p) => p.key) : [];
  return {
    parts: n,
    components: roots.size,
    groundedComponents: groundRoots.size,
    floating,
    weak,
    connections: studs.size,
    valid: floating.length === 0,
  };
}
