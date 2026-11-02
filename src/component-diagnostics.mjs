// Component colour overlay concept adapted from BrickLayer; independent implementation.
// See docs/RESEARCH_ATTRIBUTION.md. Never write these colours to a saved model.
export const COMPONENT_COLOURS = [4,1,2,14,25,5,3,19];
export function componentDiagnostics(ids, groups) {
  const membership = new Map();
  if (new Set(ids).size !== ids.length || groups.some(g=>!g.length)) throw new Error('Invalid component partition');
  const components = groups.map((indices, component) => {
    const parts = indices.map(i => {
      if (!Number.isInteger(i) || i < 0 || i >= ids.length || membership.has(ids[i])) throw new Error('Invalid component partition');
      membership.set(ids[i], component); return ids[i];
    });
    return { component, color: COMPONENT_COLOURS[component % COMPONENT_COLOURS.length], parts };
  });
  if (membership.size !== ids.length) throw new Error('Incomplete component partition');
  return { components, membership };
}
