// Comparison bookkeeping is pure. Reported usage is participant-supplied, not audited.
export function compareBrainflakesRuns(suite, runs, agents) {
  if (!suite || !Array.isArray(suite.tasks) || !suite.budget || !Array.isArray(runs) || !Array.isArray(agents) || agents.length < 2) throw new Error('Provide a suite, runs and at least two agent labels.');
  if(new Set(agents).size!==agents.length || agents.some(a=>typeof a!=='string'||!a.trim())) throw new Error('Agent labels must be unique non-empty strings.');
  const known=new Set(suite.tasks.map(t=>t.id)), seen=new Set();
  for(const run of runs){
    if(!known.has(run.task)||!agents.includes(run.agent)) throw new Error('Run references an unknown task or agent.');
    const key=JSON.stringify([run.task,run.agent]);if(seen.has(key))throw new Error('Duplicate task and agent run.');seen.add(key);
  }
  return suite.tasks.flatMap(task=>agents.map(agent=>{
    const run=runs.find(r=>r.task===task.id&&r.agent===agent);
    if(!run)return {task:task.id,agent,status:'missing',budgetComparable:false};
    // A tier may set its own budget; otherwise the suite's applies.
    const budget=task.budget ?? suite.budget;
    const comparable=['maxDiscs','maxTurns','maxTimeMs'].every(k=>run.budget?.[k]===budget[k]);
    const used=run.usage ?? {};
    const withinBudget=Number.isFinite(used.turns)&&Number.isFinite(used.elapsedMs)&&used.turns>=0&&used.elapsedMs>=0&&used.turns<=budget.maxTurns&&used.elapsedMs<=budget.maxTimeMs;
    return {task:task.id,agent,status:run.error?'failed':'submitted',budgetComparable:comparable,withinReportedBudget:withinBudget,usage:used,usageEvidence:'participant-reported',error:run.error ?? null};
  }));
}
