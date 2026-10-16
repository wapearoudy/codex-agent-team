import {readdir,readFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {nativeIdentityCandidates} from './native-identity-index.mjs';
import {TeamStore} from './team.mjs';

// Changing the host plugin registration can invalidate tools in an existing
// child. Never infer idleness from the panel task status or a spawn timeout.
export async function assertUpgradeQuiescent({teamsRoot,observer,identityLookup=nativeIdentityCandidates,idleTeamLeaderConfirmations=[],leaderHostSnapshot=null}){
 let files;try{files=await readdir(teamsRoot);}catch(e){if(e.code==='ENOENT')return {checked:0};throw e;}
 const checked=new Set(),store=new TeamStore(teamsRoot),confirmed=new Set(idleTeamLeaderConfirmations),confirmations=[];
 const ids=[...new Set(files.filter(f=>/^[a-f0-9-]{36}(?:\.v2)?\.json$/i.test(f)).map(f=>f.replace(/(?:\.v2)?\.json$/,'')))];
 for(const id of ids){
  // v2 is authoritative; the legacy JSON may only be an upgrade fence.
  // Hydrate archived tasks too so a reserved launch cannot disappear here.
  let saved=JSON.parse(await readFile(join(teamsRoot,files.includes(id+'.v2.json')?id+'.v2.json':id+'.json'),'utf8'));
  if(saved.id!==id)throw new Error('Upgrade blocked: stored team identity is unknown; no plugin files changed');
  if(saved.originalHash&&!saved.mode)saved=await store.document(id).read();
  const t=await store.archive.hydrate(saved);
  if(t.mode!=='host-leader'||['archived','superseded','delivered'].includes(t.state)||!t.leaderThreadId||!t.projectPath)continue;
  const rpc=await observer.connect(),{thread}=await rpc.call('thread/read',{threadId:t.leaderThreadId,includeTurns:true});
  if(thread?.id!==t.leaderThreadId||await realpath(thread.cwd)!==await realpath(t.projectPath))throw new Error('Upgrade blocked: native Leader identity is unknown; no plugin files changed');
  const latest=thread.turns?.at(-1),status=latest?.status==='interrupted'?(await observer.lifecycleReader?.(thread,latest.id))?.status:latest?.status;
  // Snapshot-only RPC can label a live remote turn interrupted. Persisted
  // lifecycle evidence must confirm interruption before replacing its tools.
  // An app-owned live status can corroborate an active Leader when unloaded
  // snapshot RPC synthesizes interrupted and public activity has gone stale.
  // It is NEVER terminal evidence; human no-Team confirmation is still needed,
  // and every child/startup below must independently prove actual quiescence.
  const snapshotAge=Date.now()-Date.parse(leaderHostSnapshot?.observedAt??''),hostPoll=leaderHostSnapshot?.source==='codex-app.wait_threads'&&snapshotAge>=-5000&&snapshotAge<=30000?leaderHostSnapshot?.result?.polls?.find(p=>p.thread?.id===thread.id&&p.latestTurn?.id===latest?.id&&p.thread?.status?.type==='active'&&p.latestTurn?.status==='inProgress'):null;
  const userConfirmedIdle=(status==='inProgress'||!!hostPoll)&&confirmed.has(thread.id);
  if(!latest||(!['completed','failed','interrupted'].includes(status)&&!userConfirmedIdle))throw new Error('Upgrade blocked: a native team Leader is active or unknown; wait for its current workflow before updating '+t.id);
  if(userConfirmedIdle&&t.tasks.some(task=>task.executionMode==='leader'&&task.status==='running'))throw new Error('Upgrade blocked: the Leader is executing an inline team task; human idle confirmation does not waive its work');
  checked.add(thread.id);
  const ids=new Set((t.members??[]).map(m=>m.agentThreadId).filter(Boolean));
  for(const task of t.tasks??[]){const a=task.attempts?.at(-1);if(a?.agentThreadId)ids.add(a.agentThreadId);
   else if(task.status==='running'&&a?.state==='reserved'){
    const found=await identityLookup({leaderThreadId:t.leaderThreadId,cwd:t.projectPath,agentPath:a.bootstrap?.agentPath});
    if(!found.complete)throw new Error('Upgrade blocked: reserved native startup identity is unknown; preserve its launch before updating '+t.id);
    for(const id of found.ids)ids.add(id);
   }
  }
  for(const id of ids){if(checked.has(id))continue;let run;try{run=await observer.inspectIdle(t.leaderThreadId,t.projectPath,id);}catch(error){throw new Error('Upgrade blocked: native member '+id+' in team '+t.id+' is active or unknown; preserve its tools before updating. '+error.message);}
   if(!run.quiescence||!['completed','failed','interrupted'].includes(run.quiescence.status??run.status))throw new Error('Upgrade blocked: native member is active or unknown; retain its current tools before updating '+t.id);
   checked.add(id);
  }
  // A human may confirm that an active historical Leader is doing solo work.
  // This never waives native member/startup checks or unknown Leader evidence.
  if(userConfirmedIdle)confirmations.push({teamId:t.id,leaderThreadId:thread.id,turnId:latest.id,source:'explicit-user-idle-team-confirmation',nativeMembersVerified:true,...(hostPoll?{nativeLeaderStatus:status??'unknown',hostLeaderStatus:'inProgress',hostStatusSource:leaderHostSnapshot.source,hostStatusObservedAt:leaderHostSnapshot.observedAt}:{} )});
 }
 return {checked:checked.size,source:confirmations.length?'verified-native-members-and-user-idle-team-confirmation':'verified-native-terminal-state',activePluginReplacement:confirmations.length>0,...(confirmations.length?{confirmations}:{})};
}
