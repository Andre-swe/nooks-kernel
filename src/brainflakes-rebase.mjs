import { modelToBrainflakesProgram, preserveBrainflakesProgram, runBrainflakesProgram, hasUnsupportedBrainflakesConnectionMetadata } from './brainflakes-program.mjs';

// Conservative three-way rebase for programs with retained construction history.
// The caller recompiles and mesh-checks the result before committing session state.
export function rebaseBrainflakesProgram(base, current, live, {def}={}) {
  // Both formats are accepted by the compiler. Normalize before comparing
  // histories so an older steps-based revision remains rebaseable after save.
  const normalize=p=>{
    if(!p || p.ops!==undefined || !Array.isArray(p.steps)) return p;
    const {steps,...rest}=p;return {...rest,ops:steps};
  };
  if(base?.program) base={...base,program:normalize(base.program)};
  if(current?.program) current={...current,program:normalize(current.program)};
  live=normalize(live);
  const prior=base?.program?.ops ?? [], ops=live?.ops;
  let next=current?.program?.ops;
  if(!Array.isArray(next)||!Array.isArray(ops)) throw new Error('A retained program is required for rebase.');
  // JSON object property order has no construction meaning. Array order does.
  const canonical=value=>JSON.stringify(value,(_key,v)=>v && typeof v==='object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v);
  const same=(a,b)=>canonical(a)===canonical(b);
  const prefix=(all,start)=>all.length>=start.length && start.every((op,i)=>same(op,all[i]));
  // A workbench save may have replaced the history with the canonical flat
  // representation. Recover the base history only when that representation
  // exactly matches the saved model and replay reproduces the complete edit.
  // An arbitrary rewritten program may encode intent that cannot be inferred
  // from its model, so it must not be silently replaced.
  const flat=!prefix(next,prior) && def && base?.model && current?.model && modelToBrainflakesProgram(current.model);
  if(flat &&
      current.program.system===flat.system &&
      current.program.name===flat.name &&
      Object.keys(current.program).every(k=>['system','name','set','inventory','ops'].includes(k)) &&
      same(current.program.set,flat.set) &&
      same(current.program.inventory,flat.inventory) &&
      same(next,flat.ops)) {
    const recovered=preserveBrainflakesProgram(base.program,base.model,current.model,def);
    if(recovered) {current={...current,program:recovered}; next=recovered.ops;}
  }
  // Definitions may be inserted, reordered or edited while the original
  // construction operations remain in order. Changed definitions require
  // replay and dependency checks below before they can be merged safely.
  let priorEnd=prior.length;
  const changedDefinitions=new Set();
  const changedDefinitionOps=[];
  if(!prefix(next,prior)) {
    const definitions=new Map(prior.filter(o=>o?.op==='define').map(o=>[o.name??o.id,o]));
    const seenDefs=new Set(),actions=prior.filter(o=>o?.op!=='define');
    let actionIndex=0,safe=true;
    priorEnd=0;
    for(let j=0;j<next.length;j++) {
      const op=next[j];
      if(op?.op==='define') {
        const name=op.name??op.id;
        if(typeof name!=='string'||seenDefs.has(name)) {safe=false;break;}
        if(definitions.has(name)&&!same(op,definitions.get(name))) {
          changedDefinitions.add(name);
          changedDefinitionOps.push(definitions.get(name),op);
        }
        seenDefs.add(name);
      } else if(actionIndex<actions.length) {
        if(!same(op,actions[actionIndex])) {safe=false;break;}
        actionIndex++;priorEnd=j+1;
      }
    }
    if(!safe || actionIndex!==actions.length || [...definitions.keys()].some(name=>!seenDefs.has(name)))
      throw new Error('Construction history changed or was flattened; rebase needs an explicit rebuild.');
  }
  if(!prefix(ops,prior)) throw new Error('Construction history changed or was flattened; rebase needs an explicit rebuild.');
  let suffix=ops.slice(prior.length);
  const before=base?.model ?? {discs:[],connections:[]}, after=current.model;
  let compiledCurrent=null;
  if(changedDefinitions.size) {
    const hasRemoval=list=>Array.isArray(list) && list.some(op=>op?.op==='remove'||hasRemoval(op?.ops));
    if(changedDefinitionOps.some(op=>hasRemoval(op.ops)))
      throw new Error('A changed definition includes a removal; part identity cannot be safely rebased.');
    if(!def || !preserveBrainflakesProgram(current.program,after,after,def))
      throw new Error('The changed definitions cannot be reconstructed exactly; rebase manually.');
    for(const name of new Set(suffix.filter(op=>op.op==='instance' && changedDefinitions.has(op.of)).map(op=>op.of))) {
      // An edited definition can still be used if its compiled local assembly
      // is exactly the one the agent saw. Otherwise the new occurrence would
      // silently change the agent's design and must be resolved manually.
      const original=prior.find(op=>op.op==='define'&&(op.name??op.id)===name);
      const updated=next.find(op=>op.op==='define'&&(op.name??op.id)===name);
      const a=runBrainflakesProgram({ops:original.ops},def), b=runBrainflakesProgram({ops:updated.ops},def);
      if(a.errors.length || b.errors.length || !same({discs:a.model.discs,connections:a.model.connections},{discs:b.model.discs,connections:b.model.connections}))
        throw new Error('The agent instantiates a definition changed in the saved revision; rebase manually.');
    }
    if(suffix.some(op=>op.op==='transform_instance')) {
      compiledCurrent=runBrainflakesProgram(current.program,def);
      if(compiledCurrent.errors.length) throw new Error('The saved construction cannot be reconstructed for safe rebase.');
    }
  }
  if(after.discs.some(d=>Object.keys(d).some(k=>!['id','color','pose','key','group'].includes(k)) || (d.key!==undefined && d.key!==d.id))) throw new Error('The saved model contains disc metadata the program cannot preserve; rebase manually.');
  if(hasUnsupportedBrainflakesConnectionMetadata(after)) throw new Error('The saved model contains connection metadata the program cannot preserve; rebase manually.');
  const prev=new Map(before.discs.map(d=>[d.id,d])), now=new Map(after.discs.map(d=>[d.id,d]));
  const poseSame=(a,b)=>a&&b&&a.r.every((v,i)=>v===b.r[i])&&a.t.every((v,i)=>v===b.t[i]);
  const discSame=(a,b)=>Boolean(a&&b&&a.color===b.color&&(a.group??null)===(b.group??null)&&poseSame(a.pose,b.pose));
  const changed=new Set([...new Set([...prev.keys(),...now.keys()])].filter(id=>!discSame(prev.get(id),now.get(id))));
  const poseChanged=new Set([...new Set([...prev.keys(),...now.keys()])].filter(id=>!prev.has(id)||!now.has(id)||!poseSame(prev.get(id).pose,now.get(id).pose)));
  const identityChanged=new Set([...new Set([...prev.keys(),...now.keys()])].filter(id=>!prev.has(id)||!now.has(id)));
  // Reusing an id after removing its original disc is a replacement, even
  // when the new disc happens to have identical pose and colour. Existing
  // occurrence references cannot safely be assumed to target the same part.
  for(const op of next.slice(priorEnd)) if(op?.op==='remove') {
    const id=op.name??op.id;
    if(prev.has(id)) {changed.add(id);poseChanged.add(id);identityChanged.add(id);}
  }
  const edgeMap=edges=>new Map(edges.map(e=>{const a=`${e.a.id}:${e.a.slot}`,b=`${e.b.id}:${e.b.slot}`;return [[a,b].sort().join('|'),e];}));
  const oldEdges=edgeMap(before.connections), newEdges=edgeMap(after.connections);
  const changedSlots=new Set();
  for(const [k,e] of oldEdges) if(!newEdges.has(k)) {
    changed.add(e.a.id); changed.add(e.b.id);
    changedSlots.add(`${e.a.id}:${e.a.slot}`); changedSlots.add(`${e.b.id}:${e.b.slot}`);
  }
  for(const [k,e] of newEdges) if(!oldEdges.has(k)) {
    changed.add(e.a.id); changed.add(e.b.id);
    changedSlots.add(`${e.a.id}:${e.a.slot}`); changedSlots.add(`${e.b.id}:${e.b.slot}`);
  }

  // Resolve broad close operations against the agent's original history when
  // the human changed geometry. Replaying close on the newer model could
  // otherwise join slots the agent never saw. Explicit joins preserve its
  // original intent and let the normal slot-conflict checks assess each one.
  let compiledLive=null;
  if((poseChanged.size || changedSlots.size) && suffix.some(op=>op.op==='close')) {
    if(!def) throw new Error('A part definition is required to safely rebase close operations.');
    compiledLive=runBrainflakesProgram(live,def,{captureClosures:true});
    if(compiledLive.errors.length) throw new Error('The agent’s close operation could not be reconstructed safely.');
    const closures=new Map(compiledLive.log.map(entry=>[entry.op,entry.connections]));
    const expanded=[];
    for(let i=0;i<suffix.length;i++) {
      const op=suffix[i];
      if(op.op!=='close') {expanded.push(op);continue;}
      const additions=closures.get(prior.length+i);
      if(!Array.isArray(additions)) throw new Error('The agent’s close operation could not be reconstructed safely.');
      for(const [key,e] of edgeMap(additions)) {
        const saved=newEdges.get(key);
        // If the human independently made exactly this join between the same
        // unchanged discs, it already satisfies the agent's requested closure.
        if(saved && !oldEdges.has(key) && saved.mate===e.mate &&
            prev.has(e.a.id) && prev.has(e.b.id) && !poseChanged.has(e.a.id) && !poseChanged.has(e.b.id) &&
            poseSame(prev.get(e.a.id)?.pose,now.get(e.a.id)?.pose) &&
            poseSame(prev.get(e.b.id)?.pose,now.get(e.b.id)?.pose)) continue;
        expanded.push({op:'connect',a:`${e.a.id}.slot[${e.a.slot}]`,b:`${e.b.id}.slot[${e.b.slot}]`});
      }
    }
    suffix=expanded;
  }

  // Collect definition part names and instance part mappings from the shared prefix + live ops.
  const defParts=new Map(), instanceParts=new Map();
  const collectDefs=list=>{
    for(const op of list) {
      const n=op?.name ?? op?.id;
      if(op?.op==='define' && n && Array.isArray(op.ops)) {
        const parts=[];
        let complete=true;
        for(const sub of op.ops) {
          const sn=sub?.name ?? sub?.id;
          if((sub?.op==='disc'||sub?.op==='attach')&&sn) parts.push(sn);
          else if(sub?.op==='ring'&&Array.isArray(sub.slots)) { const p=sub.prefix ?? sn ?? 'p'; sub.slots.forEach((_,k)=>parts.push(`${p}${k+1}`)); }
          else if(['define','instance','remove'].includes(sub?.op)) complete=false;
        }
        if(complete)defParts.set(n,parts); else defParts.delete(n);
      } else if(op?.op==='instance' && n && defParts.has(op.of)) {
        instanceParts.set(n,defParts.get(op.of).map(p=>`${n}-${p}`));
      }
    }
  };
  collectDefs(prior);
  collectDefs(suffix);
  // The compiler knows the actual occurrence members, including nested
  // instances and removed parts. Textual expansion above is only a fallback
  // for callers without the part definition.
  if(def && suffix.some(op=>op.op==='instance'||op.op==='transform_instance')) {
    const run=compiledLive ?? runBrainflakesProgram(live,def);
    if(run.errors.length) throw new Error('Live construction cannot be reconstructed for safe rebase.');
    for(const [name,occurrence] of Object.entries(run.occurrences)) instanceParts.set(name,occurrence.parts);
    if(compiledCurrent) for(const op of suffix) if(op.op==='transform_instance') {
      const name=op.name??op.id, oldParts=run.occurrences[name]?.parts, newParts=compiledCurrent.occurrences[name]?.parts;
      if(!prior.some(baseOp=>baseOp.op==='instance' && (baseOp.name??baseOp.id)===name))continue;
      if(!oldParts || !newParts || !same([...oldParts].sort(),[...newParts].sort()))
        throw new Error(`Instance ${name} changed membership in the saved revision; rebase manually.`);
    }
  }

  const parseEndpoint=(ref,fallbackSlot=null)=>{
    if(typeof ref!=='string') return null;
    const m=ref.match(/^([A-Za-z][\w-]{0,39})\.slot\[(\d)\]$/)||ref.match(/^([A-Za-z][\w-]{0,39})[.:](\d)$/);
    if(m) return {id:m[1],slot:Number(m[2])};
    return {id:ref.split(/\.slot\[|[.:]/)[0],slot:Number.isInteger(fallbackSlot)?fallbackSlot:null};
  };

  const touched=new Set(), geometryTouched=new Set(), colorTouched=new Set(), groupTouched=new Set(), createdByLive=new Set();
  const liveColors=new Map(),liveGroups=new Map();
  for(const op of suffix) {
    if(op.op==='close' && (poseChanged.size || changedSlots.size)) throw new Error('An operation affects the whole assembly and the saved model changed; rebase manually.');
    if(op.op==='transform_instance') {
      const inst=op.name ?? op.id, parts=instanceParts.get(inst);
      if(!parts || !parts.length) {
        if(changed.size) throw new Error('An operation affects the whole assembly and the saved model changed; rebase manually.');
      } else {
        const members=new Set(parts);
        for(const p of parts) geometryTouched.add(p);
        for(const e of after.connections) {
          if(members.has(e.a.id) && !members.has(e.b.id)) geometryTouched.add(e.b.id);
          if(members.has(e.b.id) && !members.has(e.a.id)) geometryTouched.add(e.a.id);
        }
      }
    }
    const id=op.name ?? op.id;
    if(op.op==='disc' || op.op==='attach') {
      if(id) {
        createdByLive.add(id);
        if(now.has(id) && !prev.has(id)) touched.add(id);
      }
      if(op.op==='attach') {
        const ep=parseEndpoint(op.to,op.slot ?? null);
        if(ep) {
          if(poseChanged.has(ep.id) || (ep.slot!==null && changedSlots.has(`${ep.id}:${ep.slot}`))) touched.add(ep.id);
        }
      }
    } else if(op.op==='ring') {
      const p=op.prefix ?? id ?? 'p';
      if(Array.isArray(op.slots)) op.slots.forEach((s,k)=>{
        const rid=`${p}${k+1}`;
        createdByLive.add(rid);
        if(now.has(rid) && !prev.has(rid)) touched.add(rid);
        if(typeof op.to==='string' && changedSlots.has(`${op.to}:${s}`)) touched.add(op.to);
      });
      if(typeof op.to==='string' && poseChanged.has(op.to)) touched.add(op.to);
    } else if(op.op==='instance') {
      const parts=instanceParts.get(id);
      if(!parts && changed.size) throw new Error('Instance membership is unavailable; rebase manually.');
      for(const pid of parts ?? []) {
        createdByLive.add(pid);
        if(now.has(pid) && !prev.has(pid)) touched.add(pid);
      }
      if(typeof op.to==='string') {
        const ep=parseEndpoint(op.to);
        if(ep && (poseChanged.has(ep.id) || (ep.slot!==null && changedSlots.has(`${ep.id}:${ep.slot}`)))) touched.add(ep.id);
      }
    } else if(op.op==='connect' || op.op==='disconnect') {
      for(const field of ['a','b','from','to']) if(typeof op[field]==='string') {
        const ep=parseEndpoint(op[field]);
        if(ep && (poseChanged.has(ep.id) || (ep.slot!==null && changedSlots.has(`${ep.id}:${ep.slot}`)))) touched.add(ep.id);
      }
    } else if(['remove','recolor','transform','set_group'].includes(op.op)) {
      if(id && !createdByLive.has(id)) {
        if(op.op==='recolor') {colorTouched.add(id);liveColors.set(id,op.color ?? 'yellow');}
        else if(op.op==='set_group') {groupTouched.add(id);liveGroups.set(id,op.group);}
        else if(op.op==='transform')geometryTouched.add(id);
        else touched.add(id);
      }
      if((op.op==='remove' || op.op==='transform') && id) {
        for(const e of after.connections) {
          if(e.a.id===id && poseChanged.has(e.b.id)) touched.add(e.b.id);
          if(e.b.id===id && poseChanged.has(e.a.id)) touched.add(e.a.id);
        }
      }
    }
  }
  const geometryChanged=new Set(poseChanged);
  for(const slot of changedSlots) geometryChanged.add(slot.slice(0,slot.lastIndexOf(':')));
  // Identical final property values need no conflict resolution. Identity
  // changes still conflict, even when the replacement happens to match.
  const colorChanged=id=>identityChanged.has(id)||
    (prev.get(id)?.color!==now.get(id)?.color && liveColors.get(id)!==now.get(id)?.color);
  const groupChanged=id=>identityChanged.has(id)||
    ((prev.get(id)?.group??null)!==(now.get(id)?.group??null) && liveGroups.get(id)!==(now.get(id)?.group??null));
  const conflicts=[...new Set([...touched].filter(id=>changed.has(id))
    .concat([...geometryTouched].filter(id=>geometryChanged.has(id)),[...colorTouched].filter(colorChanged),[...groupTouched].filter(groupChanged)))];
  if(conflicts.length) throw new Error(`Concurrent edits affect ${conflicts.join(', ')}; rebase manually.`);
  const prevInv=base?.program?.inventory, liveInv=live.inventory, currentInv=current.program.inventory;
  if(!same(liveInv,prevInv)&&!same(currentInv,prevInv)&&!same(liveInv,currentInv)) throw new Error('Both sides changed the disc inventory.');
  const inventory=!same(liveInv,prevInv)?liveInv:currentInv;
  const out={...current.program,ops:[...next,...suffix]};
  const normalizedName=n=>typeof n==='string'&&n.trim()?n.trim().slice(0,80):'Brain Flakes design';
  const prevName=normalizedName(base?.program?.name ?? base?.model?.name), liveName=normalizedName(live.name ?? prevName), currentName=normalizedName(current.program.name ?? current.model?.name);
  if(!same(liveName,prevName)&&!same(currentName,prevName)&&!same(liveName,currentName)) throw new Error('Both sides changed the design name.');
  const name=!same(liveName,prevName)?liveName:currentName;
  if(name===undefined) delete out.name; else out.name=name;
  if(inventory===undefined) delete out.inventory; else out.inventory=inventory;
  const prevSet=base?.program?.set, liveSet=live.set, currentSet=current.program.set;
  if(!same(liveSet,prevSet)&&!same(currentSet,prevSet)&&!same(liveSet,currentSet)) throw new Error('Both sides changed the set constraint.');
  const set=!same(liveSet,prevSet)?liveSet:currentSet;
  if(set===undefined) delete out.set; else out.set=set;
  return out;
}
