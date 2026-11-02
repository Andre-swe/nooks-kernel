// Pure triangle-surface intersection for Brain Flakes. Reports intersection,
// including touching; it does not classify penetration or contained solids.
import { apply } from './pose.mjs';

const sub = (a,b) => a.map((v,i) => v-b[i]);
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const overlap = (a,b,eps) => a.lo.every((x,i) => x <= b.hi[i]+eps && b.lo[i] <= a.hi[i]+eps);
function bounds(tris) {
  const lo = [Infinity,Infinity,Infinity], hi = [-Infinity,-Infinity,-Infinity];
  for (const t of tris) for (const p of t) for (let i=0;i<3;i++) { lo[i]=Math.min(lo[i],p[i]); hi[i]=Math.max(hi[i],p[i]); }
  return { lo, hi };
}
function tree(tris) {
  const box = bounds(tris);
  if (tris.length <= 8) return { ...box, tris };
  const axis = box.hi.map((v,i) => v-box.lo[i]).indexOf(Math.max(...box.hi.map((v,i) => v-box.lo[i])));
  tris.sort((a,b) => (a[0][axis]+a[1][axis]+a[2][axis])-(b[0][axis]+b[1][axis]+b[2][axis]));
  const mid = Math.floor(tris.length/2);
  return { ...box, left: tree(tris.slice(0,mid)), right: tree(tris.slice(mid)) };
}
function intersects(a,b,eps) {
  const ae = [sub(a[1],a[0]),sub(a[2],a[1]),sub(a[0],a[2])];
  const be = [sub(b[1],b[0]),sub(b[2],b[1]),sub(b[0],b[2])];
  const an = cross(ae[0],ae[1]), bn = cross(be[0],be[1]);
  // The additional in-plane axes handle coplanar triangles.
  const axes = [an,bn,...ae.flatMap(x => be.map(y => cross(x,y))),...ae.map(e => cross(an,e)),...be.map(e => cross(bn,e))];
  for (const axis of axes) {
    const len = Math.hypot(...axis); if (len < 1e-12) continue;
    const ap = a.map(p => dot(p,axis)), bp = b.map(p => dot(p,axis));
    if (Math.max(...ap) < Math.min(...bp)-eps*len || Math.max(...bp) < Math.min(...ap)-eps*len) return false;
  }
  return true;
}
function nodesIntersect(a,b,eps) {
  if (!overlap(a,b,eps)) return false;
  if (a.tris && b.tris) return a.tris.some(x => b.tris.some(y => intersects(x,y,eps)));
  if (a.tris) return nodesIntersect(a,b.left,eps) || nodesIntersect(a,b.right,eps);
  if (b.tris) return nodesIntersect(a.left,b,eps) || nodesIntersect(a.right,b,eps);
  return nodesIntersect(a.left,b.left,eps) || nodesIntersect(a.left,b.right,eps) || nodesIntersect(a.right,b.left,eps) || nodesIntersect(a.right,b.right,eps);
}
function triangles(mesh, pose) {
  const v = mesh?.vertices;
  if (!v?.length || v.length % 9) throw new Error('Expected triangle mesh.');
  const result=[];
  for (let i=0;i<v.length;i+=9) result.push([0,3,6].map(j => apply(pose,[v[i+j],v[i+j+1],v[i+j+2]])));
  return result;
}
export function triangleSurfacesIntersect(mesh, poseA, poseB, { epsilon = 1e-7 } = {}) {
  if (!Number.isFinite(epsilon) || epsilon < 0) throw new Error('Invalid epsilon.');
  return nodesIntersect(tree(triangles(mesh,poseA)),tree(triangles(mesh,poseB)),epsilon);
}

// A surface crossing is evidence requiring review; contact and penetration are
// not distinguished, and one closed solid wholly inside another is not detected.
export function inspectAssemblySurfaces(mesh, model) {
  if (model?.system !== 'brainflakes-standard' || !Array.isArray(model.discs)) throw new Error('Not a Brain Flakes assembly.');
  const trees = model.discs.map(p => tree(triangles(mesh, p.pose))), intersections = [];
  for (let i=0;i<trees.length;i++) for (let j=i+1;j<trees.length;j++) {
    if (nodesIntersect(trees[i],trees[j],1e-7)) intersections.push([model.discs[i].id,model.discs[j].id]);
  }
  return { status: intersections.length ? 'surface-intersections' : 'no-surface-intersections', intersections, limitations: ['Surface contact is not distinguished from penetration.', 'Full containment is not detected.', 'Snap-fit deformation and assembly paths are not simulated.'] };
}
