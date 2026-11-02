// Conservative spatial broad phase, in native millimetres. Returns pairs in
// model order; callers must still perform their own precise collision test.
export function* nearbyDiscPairs(discs, distance) {
  if (!Number.isFinite(distance) || distance <= 0) throw new Error('Invalid broad-phase distance.');
  const cells = new Map(), coordinates = [];
  const key = (x,y,z) => `${x},${y},${z}`;
  for (let i=0;i<discs.length;i++) {
    const c=discs[i].pose.t.map(v=>Math.floor(v/distance)); coordinates.push(c);
    const k=key(...c), list=cells.get(k);
    if (list) list.push(i); else cells.set(k,[i]);
  }
  const limit=distance*distance;
  for(let i=0;i<discs.length;i++) {
    const [x,y,z]=coordinates[i], candidates=[];
    for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++) for(let dz=-1;dz<=1;dz++) {
      for(const j of cells.get(key(x+dx,y+dy,z+dz)) ?? []) {
        if(j<=i) continue;
        const a=discs[i].pose.t, b=discs[j].pose.t;
        if((a[0]-b[0])**2+(a[1]-b[1])**2+(a[2]-b[2])**2<=limit) candidates.push(j);
      }
    }
    candidates.sort((a,b)=>a-b);
    for(const j of candidates) yield [i,j];
  }
}
