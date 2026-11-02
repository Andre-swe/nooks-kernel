// Straight-line insertion screen. Bounding boxes and the part's top axis are
// geometric approximations, not a physical assembly simulation. No plan is changed.
const EPS = 1e-5;
function bounds(p) {
  if (p.origin && p.extent?.length === 6 && [...p.extent,p.x,p.y,p.z].every(Number.isFinite) && p.extent.slice(0, 3).every((v, i) => v < p.extent[i + 3])) return p.extent.map((v, i) => v + [p.x, p.y, p.z][i % 3]);
  if (p.origin || ![p.x, p.y, p.z, p.w, p.h, p.d].every(Number.isFinite) || !(p.w > 0 && p.h > 0 && p.d > 0)) return null;
  const rotation = ((p.rotation ?? 0) % 360 + 360) % 360;
  if (![0,90,180,270].includes(rotation)) return null;
  const turn = rotation === 90 || rotation === 270, w = turn ? p.d : p.w, d = turn ? p.w : p.d;
  return [p.x-w/2,p.y,p.z-d/2,p.x+w/2,p.y+p.h,p.z+d/2];
}
function axis(p) {
  if (!p.origin) return [1, 1];
  if (!p.ldMatrix || p.ldMatrix.length !== 9) return null;
  const v = [p.ldMatrix[1], p.ldMatrix[4], p.ldMatrix[7]], a = v.findIndex((x) => Math.abs(Math.abs(x)-1) < EPS);
  return a >= 0 && v.every((x, i) => i === a || Math.abs(x) < EPS) ? [a, Math.sign(v[a])] : null;
}
function obstructs(a, b, [axis, sign]) {
  for (let i=0; i<3; i++) if (i !== axis && (a[i+3] <= b[i]+EPS || b[i+3] <= a[i]+EPS)) return false;
  return sign > 0 ? b[axis+3] > a[axis+3]+EPS : b[axis] < a[axis]-EPS;
}
// A step's pieces may be inserted in any order. Try clear pieces first, but do
// not infer an order between different steps or move a saved human edit.
export function insertionFindings(model, { maxComparisons = 100000 } = {}) {
  const byKey = new Map((model.parts ?? []).map(p => [p.key, p]));
  const boxes = new Map([...byKey].map(([k,p]) => [k,bounds(p)]));
  const lines = new Map(), findings = [], unsupported = [];
  let comparisons = 0, exhausted = false;
  for (const [i, step] of (model.steps ?? []).entries()) {
    const line = step.aside ? `aside:${step.assembly}` : 'main';
    if (!lines.has(line)) lines.set(line, []);
    const built = lines.get(line);
    if (step.attach) {
      const sub = lines.get(`aside:${step.assembly}`) ?? [];
      if (sub.length) unsupported.push({ step:i+1, reason:'Subassembly attachment path is not checked.' });
      built.push(...sub); continue;
    }
    for (const key of step.parts ?? []) if (!byKey.has(key)) unsupported.push({step:i+1,key,reason:'Instruction references a part that is unavailable.'});
    const pending = (step.parts ?? []).filter(k => byKey.has(k)).sort((a,b) => (byKey.get(a).y ?? 0) - (byKey.get(b).y ?? 0));
    while (pending.length && !exhausted) {
      let picked = -1, blocked = null;
      for (let j=0; j<pending.length; j++) {
        const key = pending[j], p = byKey.get(key), box = boxes.get(key), dir = axis(p);
        if (!box || !dir) { unsupported.push({step:i+1,key,reason:'Part geometry or insertion axis is unavailable.'}); picked=j; break; }
        let hit = null;
        for (const other of built) {
          if (++comparisons > maxComparisons) { exhausted=true; break; }
          const b = boxes.get(other);
          if (!b) { unsupported.push({step:i+1,key:other,reason:'Obstruction geometry is unavailable.'}); continue; }
          if (obstructs(box,b,dir)) { hit=other; break; }
        }
        if (exhausted) break;
        if (hit === null) {
          // A piece that would obstruct a different piece in this same step
          // should go later, if a clear ordering exists. This is only a
          // candidate ordering; it does not modify the document.
          let neededFirst = null;
          for (const other of pending) {
            if (other === key) continue;
            if (++comparisons > maxComparisons) { exhausted = true; break; }
            const otherBox = boxes.get(other), otherAxis = axis(byKey.get(other));
            if (otherBox && otherAxis && obstructs(otherBox, box, otherAxis)) { neededFirst = { step:i+1, key:other, obstruction:key, direction:otherAxis, sameStep:true }; break; }
          }
          if (exhausted) break;
          if (!neededFirst) { picked=j; break; }
          // Retain a fallback for cycles: when all paths from already-built
          // pieces are clear, any order is an unresolved same-step conflict.
          if (!blocked) blocked = neededFirst;
          continue;
        }
        if (!blocked) blocked={step:i+1,key,obstruction:hit,direction:dir};
      }
      if (exhausted) break;
      if (picked < 0) {
        // In a same-step cycle, report the piece that becomes blocked by the
        // chosen piece; for an already-built obstruction, choose its victim.
        findings.push(blocked);
        picked = pending.indexOf(blocked.sameStep ? blocked.obstruction : blocked.key);
      }
      built.push(pending.splice(picked,1)[0]);
    }
    if (exhausted) break;
  }
  if (exhausted) unsupported.push({reason:'Insertion comparison limit reached.'});
  return { status: unsupported.length ? 'incomplete' : findings.length ? 'blocked' : 'clear', findings, unsupported, comparisons,
    assumption:'Straight-line insertion along each part’s top axis using bounding boxes; this is a geometric estimate, not proof of assembly by hand.' };
}
