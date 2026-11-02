// Static gravity-support screen using the actual closed STL vertices and its
// volume centroid. This is an approximation, not a rigid-body simulation.
import { apply } from './pose.mjs';

const vertexCache = new WeakMap();
function uniqueVertices(mesh) {
  let cached=vertexCache.get(mesh);
  if(cached) return cached;
  const unique=new Map(), v=mesh.vertices;
  for(let i=0;i<v.length;i+=3) {
    const key=`${v[i]},${v[i+1]},${v[i+2]}`, item=unique.get(key);
    if(item) item.count++; else unique.set(key,{x:v[i],y:v[i+1],z:v[i+2],count:1});
  }
  cached=[...unique.values()]; vertexCache.set(mesh,cached); return cached;
}

function volumeCentroid(mesh) {
  const v=mesh.vertices; let sum=0, x=0,y=0,z=0;
  for(let i=0;i<v.length;i+=9){
    const [ax,ay,az,bx,by,bz,cx,cy,cz]=v.slice(i,i+9);
    const w=ax*(by*cz-bz*cy)+ay*(bz*cx-bx*cz)+az*(bx*cy-by*cx);
    sum+=w; x+=(ax+bx+cx)*w; y+=(ay+by+cy)*w; z+=(az+bz+cz)*w;
  }
  if(!Number.isFinite(sum)||Math.abs(sum)<1e-9) throw new Error('Cannot determine mesh volume centroid.');
  return [x/(4*sum),y/(4*sum),z/(4*sum)];
}
const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
function hull(points){
  const sorted=points.sort((a,b)=>a[0]-b[0]||a[1]-b[1]).filter((p,i,a)=>!i||Math.abs(p[0]-a[i-1][0])>1e-6||Math.abs(p[1]-a[i-1][1])>1e-6);
  if(sorted.length<3)return sorted;
  const lower=[], upper=[];
  for(const p of sorted){while(lower.length>=2&&cross(lower.at(-2),lower.at(-1),p)<=0)lower.pop();lower.push(p);}
  for(const p of [...sorted].reverse()){while(upper.length>=2&&cross(upper.at(-2),upper.at(-1),p)<=0)upper.pop();upper.push(p);}
  return lower.slice(0,-1).concat(upper.slice(0,-1));
}
// Discs resting on one another (mesh surface contacts) count as one stack here.
export function assessBrainflakesSupport(model,mesh,{contactToleranceMm=0.1,contacts=[]}={}){
  if(!Number.isFinite(contactToleranceMm)||contactToleranceMm<=0||contactToleranceMm>1)throw new Error('Invalid ground contact tolerance.');
  if(!model.discs.length)return {status:'not-checked',simulated:false,reason:'No discs.'};
  const local=volumeCentroid(mesh),vertices=uniqueVertices(mesh),adj=new Map(model.discs.map(d=>[d.id,[]])),byId=new Map(model.discs.map(d=>[d.id,d]));
  for(const e of model.connections)if(adj.has(e.a.id)&&adj.has(e.b.id)){adj.get(e.a.id).push(e.b.id);adj.get(e.b.id).push(e.a.id);}
  for(const c of contacts)if(adj.has(c.a)&&adj.has(c.b)){adj.get(c.a).push(c.b);adj.get(c.b).push(c.a);}
  const groups=[],seen=new Set();for(const d of model.discs)if(!seen.has(d.id)){const g=[d.id];seen.add(d.id);for(let i=0;i<g.length;i++)for(const id of adj.get(g[i]))if(!seen.has(id)){seen.add(id);g.push(id);}groups.push(g);}
  const lowest=new Map(); let ground=Infinity;
  for(const d of model.discs){let z=Infinity;const r=d.pose.r,t=d.pose.t;for(const v of vertices)z=Math.min(z,r[6]*v.x+r[7]*v.y+r[8]*v.z+t[2]);lowest.set(d.id,z);ground=Math.min(ground,z);}
  const components=groups.map(ids=>{
    const center=[0,0,0];for(const id of ids){const p=apply(byId.get(id).pose,local);for(let i=0;i<3;i++)center[i]+=p[i]/ids.length;}
    const contacts=[];let contactCount=0;for(const id of ids)if(lowest.get(id)<=ground+contactToleranceMm){const d=byId.get(id);for(const v of vertices){const p=apply(d.pose,[v.x,v.y,v.z]);if(p[2]<=ground+contactToleranceMm){contacts.push([p[0],p[1]]);contactCount+=v.count;}}}
    const polygon=hull(contacts),inside=polygon.length>=3&&polygon.every((p,i)=>cross(p,polygon[(i+1)%polygon.length],center)>=-1e-6);
    const status=polygon.length<3?'inconclusive':inside?'supported-estimate':'unsupported-estimate';
    return {ids,status,centerOfMassMm:center,groundContacts:contactCount,supportPolygonMm:polygon};
  });
  return {status:components.some(c=>c.status==='unsupported-estimate')?'unsupported-estimate':components.every(c=>c.status==='supported-estimate')?'supported-estimate':'inconclusive',simulated:false,engine:'static support polygon',groundZMm:ground,contactToleranceMm,components,assumptions:['Identical uniformly dense rigid discs; each connected component is rigid.',...(contacts.length?['Discs resting on one another are treated as one rigid stack; friction and sliding are not modelled. Run test_gravity.']:[]),'Ground is horizontal in native XY at the lowest mesh point.','Contact vertices within tolerance form a convex support polygon.'],limitations:['No dynamic gravity, inter-component support, snap-fit deformation, joint forces, friction limits or retention are simulated.','Mesh self-intersection and physical material properties are not verified.']};
}
