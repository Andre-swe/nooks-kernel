// Binary STL inspection in native CAD millimetres. No DOM, filesystem or network.
// The supplied third-party mesh is deliberately supplied by the caller.
export function readBinaryStl(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 84) throw new Error('STL is shorter than its binary header.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  if (84 + count * 50 !== bytes.byteLength) throw new Error('Invalid binary STL length.');
  if (!count) throw new Error('STL contains no triangles.');
  const vertices = new Float64Array(count * 9);
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < 9; j++) {
      const value = view.getFloat32(84 + i * 50 + 12 + j * 4, true);
      if (!Number.isFinite(value)) throw new Error('STL contains a non-finite vertex.');
      vertices[i * 9 + j] = value;
    }
  }
  return { triangleCount: count, vertices };
}

// Exact unordered triangle correspondence under reflection in the local X=0
// plane. Equal surfaces with a different triangulation need not pass this test.
export function auditDiscReflection(mesh) {
  const v=mesh?.vertices;
  if(!v || !v.length || v.length%9)throw new Error('Expected triangle vertices.');
  const key=(i,mirror)=>{
    const points=[];
    for(let j=0;j<3;j++){
      const p=[v[i+j*3]*(mirror?-1:1),v[i+j*3+1],v[i+j*3+2]];
      if(p.some(x=>!Number.isFinite(x)))throw new Error('Non-finite vertex.');
      points.push(p.map(x=>Object.is(x,-0)?'0':String(x)).join(','));
    }
    return points.sort().join('|');
  };
  const triangles=new Map();
  for(let i=0;i<v.length;i+=9){const k=key(i,false);triangles.set(k,(triangles.get(k)??0)+1);}
  let matched=0;
  for(let i=0;i<v.length;i+=9){const k=key(i,true),n=triangles.get(k)??0;if(n){matched++;triangles.set(k,n-1);}}
  const total=v.length/9;
  return {axis:'local-x',exactTriangleCorrespondence:matched===total,triangles:total,matchedTriangles:matched,unmatchedTriangles:total-matched,method:'exact reflected triangle-vertex coordinates, ignoring winding',limitations:['Different triangulations can describe the same surface; this is not a surface-distance or physical-symmetry proof.']};
}

// Assumes a disc centred on the CAD XY origin with its normal along Z. The minimum
// vertex radius is only an estimate of the hole, not a fitted circle or a slot root.
export function measureDisc(mesh) {
  const v = mesh.vertices;
  if (!v || !v.length || v.length % 9) throw new Error('Expected triangle vertices.');
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let innerRadius = Infinity, outerRadius = 0;
  for (let i = 0; i < v.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (!Number.isFinite(v[i + k])) throw new Error('Non-finite vertex.');
      min[k] = Math.min(min[k], v[i + k]); max[k] = Math.max(max[k], v[i + k]);
    }
    const radius = Math.hypot(v[i], v[i + 1]);
    innerRadius = Math.min(innerRadius, radius); outerRadius = Math.max(outerRadius, radius);
  }
  return { bounds: { min, max }, xyExtents: [max[0] - min[0], max[1] - min[1]], thickness: max[2] - min[2], minVertexRadius: innerRadius, maxVertexRadius: outerRadius, triangleCount: v.length / 9 };
}

// Outermost projected triangle-edge intersection for each ray in the XY plane.
// This is an inspection tool, not a collision test or proof of connector fit.
export function radialProfile(mesh, samples = 360) {
  if (!Number.isInteger(samples) || samples < 8 || samples > 4096) throw new Error('Invalid profile sample count.');
  const v = mesh.vertices;
  if (!v || !v.length || v.length % 9) throw new Error('Expected triangle vertices.');
  const profile = [];
  for (let i = 0; i < samples; i++) {
    const angle = i * 2 * Math.PI / samples, x = Math.cos(angle), y = Math.sin(angle);
    let radius = 0;
    for (let j = 0; j < v.length; j += 9) for (let k = 0; k < 3; k++) {
      const a = j + k * 3, b = j + ((k + 1) % 3) * 3;
      const ax = v[a], ay = v[a + 1], dx = v[b] - ax, dy = v[b + 1] - ay;
      const denominator = x * dy - y * dx;
      if (Math.abs(denominator) < 1e-12) continue;
      const t = (ax * dy - ay * dx) / denominator, u = (ax * y - ay * x) / denominator;
      if (t >= 0 && u >= -1e-9 && u <= 1 + 1e-9) radius = Math.max(radius, t);
    }
    profile.push({ angleDegrees: i * 360 / samples, radius });
  }
  return profile;
}

// Weld only for topology inspection; rendering and collision keep original STL
// vertices. An edge with two incident triangles is necessary, not sufficient,
// evidence of a closed manifold (self-intersection is a separate check).
export function auditMesh(mesh, weldTolerance = 1e-5) {
  if (!(weldTolerance>0) || !Number.isFinite(weldTolerance)) throw new Error('Invalid weld tolerance.');
  measureDisc(mesh);
  const points=new Map(),parents=[],edges=new Map();let degenerate=0,volume=0;
  const root=i=>{while(parents[i]!==i){parents[i]=parents[parents[i]];i=parents[i];}return i;};
  const v=mesh.vertices;
  for(let i=0;i<v.length;i+=9){
    const ids=[];
    for(let j=0;j<9;j+=3){const key=[v[i+j],v[i+j+1],v[i+j+2]].map(x=>Math.round(x/weldTolerance)).join(',');if(!points.has(key)){points.set(key,parents.length);parents.push(parents.length);}ids.push(points.get(key));}
    if(new Set(ids).size<3){degenerate++;continue;}
    for(let j=0;j<3;j++){const a=ids[j],b=ids[(j+1)%3],key=a<b?`${a}:${b}`:`${b}:${a}`;const e=edges.get(key)??{count:0,balance:0};e.count++;e.balance+=a<b?1:-1;edges.set(key,e);parents[root(a)]=root(b);}
    const [ax,ay,az,bx,by,bz,cx,cy,cz]=v.slice(i,i+9);
    volume+=(ax*(by*cz-bz*cy)+ay*(bz*cx-bx*cz)+az*(bx*cy-by*cx))/6;
  }
  const boundary=[...edges.values()].filter(e=>e.count===1).length,nonManifold=[...edges.values()].filter(e=>e.count>2).length,inconsistent=[...edges.values()].filter(e=>e.count===2&&e.balance!==0).length;
  return {weldTolerance,vertices:points.size,triangles:v.length/9,boundaryEdges:boundary,nonManifoldEdges:nonManifold,inconsistentlyOrientedEdges:inconsistent,degenerateTriangles:degenerate,components:new Set(parents.map((_,i)=>root(i))).size,signedVolumeMM3:volume,closedOriented:!boundary&&!nonManifold&&!inconsistent&&!degenerate,limitations:['Does not test mesh self-intersection.','Vertices are welded within the reported quantization tolerance.']};
}
