// Pure inspection of standard-disc assemblies. Coordinates are native CAD mm;
// native Z is up in the workbench. Symmetry is an optional design constraint.
import { apply, dir, compose } from './pose.mjs';
import { slotFrame } from './brainflakes.mjs';

export function inspectBrainflakesParts(model, def, { ids = null } = {}) {
  if (ids !== null && (!Array.isArray(ids) || ids.some(id=>typeof id !== 'string'))) throw new Error('ids must be a list of disc identifiers.');
  const wanted = ids === null ? null : new Set(ids);
  const discs = model.discs.filter(d=>!wanted || wanted.has(d.id));
  if (wanted && discs.length !== wanted.size) throw new Error('Unknown selected disc.');
  const occupied=new Map();
  for(const edge of model.connections) for(const end of [edge.a,edge.b]) {
    let slots=occupied.get(end.id); if(!slots) occupied.set(end.id,slots=new Set()); slots.add(end.slot);
  }
  return discs.map(d=>({id:d.id,color:d.color,pose:d.pose,center:apply(d.pose,[0,0,def.midplane]),normal:dir(d.pose,[0,0,1]),slots:Array.from({length:8},(_,slot)=>{
    const frame=compose(d.pose,slotFrame(def,slot));
    return {slot,free:!occupied.get(d.id)?.has(slot),at:frame.t,outward:[frame.r[0],frame.r[3],frame.r[6]]};
  })}));
}

// Tests reflected centers, disk-plane normals, colours, slot frames and graph
// edges. Mesh triangle correspondence is a separate surface measurement.
export function checkBrainflakesSymmetry(model, def, { axis='x', coordinate=0, tolerance=0.1, colors=true, connections=false } = {}) {
  const k = ['x','y','z'].indexOf(axis);
  if(k<0 || !Number.isFinite(coordinate) || !Number.isFinite(tolerance) || tolerance<=0 || tolerance>2) throw new Error('Invalid symmetry plane or tolerance.');
  const list=inspectBrainflakesParts(model,def), available=new Set(list.map(d=>d.id)), unmatched=[], pairs=[], cells=new Map();
  const cellOf=p=>p.map(x=>Math.floor(x/tolerance));
  const cellKey=(x,y,z)=>`${x},${y},${z}`;
  for(let i=0;i<list.length;i++){
    const [x,y,z]=cellOf(list[i].center),key=cellKey(x,y,z);
    if(!cells.has(key))cells.set(key,[]);cells.get(key).push(i);
  }
  for (const part of list) {
    if (!available.has(part.id)) continue;
    const p=[...part.center], n=[...part.normal]; p[k]=2*coordinate-p[k]; n[k]*=-1;
    const [cx,cy,cz]=cellOf(p), candidates=[];
    for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++)for(const index of cells.get(cellKey(cx+x,cy+y,cz+z))??[]){
      const other=list[index];
      if(!available.has(other.id) || (colors && other.color!==part.color))continue;
      const distance=Math.hypot(...p.map((v,i)=>v-other.center[i])),alignment=Math.abs(n.reduce((v,x,i)=>v+x*other.normal[i],0));
      if(distance<=tolerance && alignment>=0.9999)candidates.push({other,distance,index});
    }
    candidates.sort((a,b)=>a.distance-b.distance || a.index-b.index);
    if (!candidates.length) { unmatched.push(part.id); available.delete(part.id); continue; }
    const match=candidates[0].other; available.delete(part.id); available.delete(match.id); pairs.push([part.id,match.id]);
  }
  const byId=new Map(list.map(d=>[d.id,d])), mates=new Map(), slotMatches=new Map(), unmatchedSlots=[];
  for(const [a,b] of pairs){mates.set(a,b);mates.set(b,a);}
  for(const part of list){
    const partner=byId.get(mates.get(part.id));
    if(!partner)continue;
    for(const slot of part.slots){
      const p=[...slot.at], n=[...slot.outward];p[k]=2*coordinate-p[k];n[k]*=-1;
      const options=partner.slots.map(s=>({s,d:Math.hypot(...p.map((v,i)=>v-s.at[i])),dot:n.reduce((v,x,i)=>v+x*s.outward[i],0)})).filter(x=>x.d<=tolerance&&x.dot>=0.9999).sort((a,b)=>a.d-b.d);
      if(options.length!==1) unmatchedSlots.push({id:part.id,slot:slot.slot});
      else slotMatches.set(`${part.id}\0${slot.slot}`,options[0].s.slot);
    }
  }
  const edgeKey=(a,b)=>[`${a.id}\0${a.slot}`,`${b.id}\0${b.slot}`].sort().join('\u0001');
  const edges=new Set(model.connections.map(e=>edgeKey(e.a,e.b))), missingEdges=[];
  for(const edge of model.connections){
    const a={id:mates.get(edge.a.id),slot:slotMatches.get(`${edge.a.id}\0${edge.a.slot}`)}, b={id:mates.get(edge.b.id),slot:slotMatches.get(`${edge.b.id}\0${edge.b.slot}`)};
    if(a.id===undefined||b.id===undefined||a.slot===undefined||b.slot===undefined||!edges.has(edgeKey(a,b)))missingEdges.push(edge);
  }
  const slotCorrespondence={passed:unmatched.length===0 && unmatchedSlots.length===0,unmatched:unmatchedSlots.slice(0,100),unmatchedCount:unmatchedSlots.length};
  const edgeCorrespondence={passed:slotCorrespondence.passed && missingEdges.length===0,missing:missingEdges.slice(0,100),missingCount:missingEdges.length};
  const positional=list.length>0 && unmatched.length===0;
  return { axis,coordinate,tolerance,colors,passed:positional && (!connections || edgeCorrespondence.passed),unmatched,pairs,slotCorrespondence,edgeCorrespondence,method:'reflected disc centers, plane normals, slot frames, graph edges and optional colors',limitations:['Slot correspondence uses the stated geometric tolerance; it does not compare exact reflected mesh triangles.'] };
}
