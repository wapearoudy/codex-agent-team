import {realpath} from 'node:fs/promises';

export const usageWindow=team=>({since:team.createdAt,until:team.finalAcceptance?.at??team.archival?.at??(team.state==='superseded'?team.events?.findLast(e=>e.type==='user-triggered-team-rebuild')?.at??team.updatedAt:team.state==='cancelled'?team.updatedAt:null)??null});
export const registeredContextIds=team=>[...new Set([...team.tasks.flatMap(t=>t.attempts??[]).map(a=>a.agentThreadId),...(team.members??[]).map(m=>m.agentThreadId),...(team.contextHistory??[]).map(c=>c.threadId)].filter(Boolean))].sort();
export const usageKey=team=>JSON.stringify([team.id,team.leaderThreadId,team.projectPath,usageWindow(team),registeredContextIds(team)]);
const parent=thread=>thread.parentThreadId??thread.source?.subAgent?.thread_spawn?.parent_thread_id;
const created=thread=>typeof thread.createdAt==='number'?thread.createdAt*1000:Date.parse(thread.createdAt);

// A fallback context contributes cost, never execution authority or acceptance.
// Validate metadata before opening any child's public token counters.
export async function observeTeamUsage(observer,team){
  const rpc=await observer.connect(),{thread:leader}=await rpc.call('thread/read',{threadId:team.leaderThreadId,includeTurns:false});
  if(leader?.id!==team.leaderThreadId||await realpath(leader.cwd)!==await realpath(team.projectPath))throw new Error('Leader usage identity mismatch');
  const window=usageWindow(team),registered=new Set(registeredContextIds(team)),contexts=[];
  const measure=async(thread,kind)=>{try{return {threadId:thread.id,kind,...await observer.publicFeed.usageWindow(thread,window)};}catch(error){return {threadId:thread.id,kind,usage:null,complete:false,reason:error.message};}};
  contexts.push(await measure(leader,'leader'));
  let candidates=[...registered],discoveryComplete=true,excludedCount=0;
  try{
    const {thread:snapshot}=await rpc.call('thread/read',{threadId:team.leaderThreadId,includeTurns:true});
    if(snapshot?.id!==team.leaderThreadId)throw new Error('Leader snapshot identity mismatch');
    candidates=[...new Set([...candidates,...(snapshot.turns??[]).flatMap(t=>t.items??[]).filter(i=>i.type==='subAgentActivity'&&i.agentThreadId).map(i=>i.agentThreadId)])];
  }catch{discoveryComplete=false;}
  // Bound metadata work; overflow is reported as incomplete accounting.
  if(candidates.length>128){discoveryComplete=false;candidates=registered.size>=128?[...registered].slice(-128):[...registered,...candidates.filter(id=>!registered.has(id)).slice(-(128-registered.size))];}
  for(const id of candidates){
    try{
      const {thread}=await rpc.call('thread/read',{threadId:id,includeTurns:false});
      if(thread?.id!==id||parent(thread)!==team.leaderThreadId||await realpath(thread.cwd)!==await realpath(team.projectPath)){excludedCount++;if(registered.has(id))contexts.push({threadId:id,kind:'member',usage:null,complete:false,reason:'Member usage identity mismatch'});continue;}
      const at=created(thread),from=Date.parse(window.since),until=window.until?Date.parse(window.until):Infinity;
      if(!registered.has(id)&&(!Number.isFinite(at)||at<from||at>until)){if(!Number.isFinite(at))discoveryComplete=false;else excludedCount++;continue;}
      contexts.push(await measure(thread,registered.has(id)?'member':'unregistered-native'));
    }catch{if(registered.has(id))contexts.push({threadId:id,kind:'member',usage:null,complete:false,reason:'Native member usage unavailable'});else discoveryComplete=false;}
  }
  return {source:'host-observed-team-contexts',window,observedAt:new Date().toISOString(),contexts,discoveryComplete,excludedCount,complete:discoveryComplete&&contexts.every(c=>c.complete),inferredContextsAreExecutionAuthority:false};
}
