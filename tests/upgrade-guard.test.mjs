import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertUpgradeQuiescent} from '../src/upgrade-guard.mjs';
test('upgrade preflight uses native terminal evidence including unbound startup, not panel status',async t=>{
 const root=await mkdtemp(join(tmpdir(),'upgrade-guard-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const team={id:'11111111-1111-1111-1111-111111111111',mode:'host-leader',state:'active',leaderThreadId:'leader',projectPath:root,members:[],tasks:[{status:'running',attempts:[{state:'reserved',bootstrap:{taskName:'qa'}}]}]};
 await writeFile(join(root,team.id+'.json'),JSON.stringify(team));
 let state='completed',memberState='completed',calls=0;
 const observer={connect:async()=>({call:async()=>({thread:{id:'leader',cwd:root,turns:[{status:state}]}})}),inspectIdle:async(l,p,id)=>{calls++;assert.equal(id,'child');return {status:'unknown',...(memberState==='completed'?{quiescence:{source:'native',status:memberState}}:{})};}};
 const check=extra=>assertUpgradeQuiescent({teamsRoot:root,observer,identityLookup:async()=>({complete:true,ids:['child']}),...extra});
 assert.equal((await check()).checked,2);assert.equal(calls,1);
 state='inProgress';await assert.rejects(check,/Leader is active/);assert.equal(calls,1);
 const humanIdle=await check({idleTeamLeaderConfirmations:['leader']});assert.equal(humanIdle.confirmations[0].source,'explicit-user-idle-team-confirmation');assert.equal(calls,2);
 memberState='inProgress';await assert.rejects(()=>check({idleTeamLeaderConfirmations:['leader']}),/member is active/);memberState='completed';
 await assert.rejects(()=>check({idleTeamLeaderConfirmations:['leader'],identityLookup:async()=>({complete:false,ids:[]})}),/startup identity is unknown/);
 state='interrupted';await assert.rejects(()=>check({idleTeamLeaderConfirmations:['leader']}),/Leader is active/);assert.equal(calls,3);
 state='completed';memberState='inProgress';await assert.rejects(check,/member is active/);
 memberState='completed';await assert.rejects(()=>check({identityLookup:async()=>({complete:false,ids:[]})}),/startup identity is unknown/);
 assert.deepEqual(JSON.parse(await import('node:fs/promises').then(m=>m.readFile(join(root,team.id+'.json'),'utf8'))),team);
 // Real installations have a v2 manifest and a legacy upgrade fence.
 await writeFile(join(root,team.id+'.json'),JSON.stringify({id:team.id,requiresTeamWorkspaceVersion:'0.9.0',originalHash:'f'.repeat(64)}));
 await writeFile(join(root,team.id+'.v2.json'),JSON.stringify({...team,archiveManifest:{schemaVersion:2,segments:[]},requiresTeamWorkspaceVersion:'0.40.0'}));
 assert.equal((await check()).checked,2);
 await rm(join(root,team.id+'.json'));assert.equal((await check()).checked,2);
});
test('current app active status corroborates only the same user-confirmed Leader and never waives a child check',async t=>{
 const root=await mkdtemp(join(tmpdir(),'upgrade-host-status-'));t.after(()=>rm(root,{recursive:true,force:true}));const team={id:'22222222-2222-4222-8222-222222222222',mode:'host-leader',state:'active',leaderThreadId:'leader',projectPath:root,members:[{agentThreadId:'child'}],tasks:[]};await writeFile(join(root,team.id+'.json'),JSON.stringify(team));let child='completed';
 const observer={connect:async()=>({call:async()=>({thread:{id:'leader',cwd:root,turns:[{id:'turn',status:'interrupted'}]}})}),lifecycleReader:async()=>({status:'unknown',source:'persisted-native-activity-stale'}),inspectIdle:async()=>({quiescence:{status:child}})};
 const snapshot={source:'codex-app.wait_threads',observedAt:new Date().toISOString(),result:{polls:[{thread:{id:'leader',status:{type:'active'}},latestTurn:{id:'turn',status:'inProgress'}}]}};
 const check=extra=>assertUpgradeQuiescent({teamsRoot:root,observer,leaderHostSnapshot:snapshot,idleTeamLeaderConfirmations:['leader'],...extra});const r=await check();assert.equal(r.confirmations[0].nativeLeaderStatus,'unknown');assert.equal(r.confirmations[0].hostLeaderStatus,'inProgress');assert.equal(r.checked,2);
 for(const change of [{source:'model-claim'}, {observedAt:new Date(Date.now()-31000).toISOString()}, {result:{polls:[{thread:{id:'other',status:{type:'active'}},latestTurn:{id:'turn',status:'inProgress'}}]}}, {result:{polls:[{thread:{id:'leader',status:{type:'active'}},latestTurn:{id:'old-turn',status:'inProgress'}}]}}])await assert.rejects(()=>check({leaderHostSnapshot:{...snapshot,...change}}),/Leader is active or unknown/);
 await assert.rejects(()=>check({idleTeamLeaderConfirmations:[]}),/Leader is active or unknown/);child='unknown';await assert.rejects(check,/member is active or unknown/);assert.deepEqual(JSON.parse(await import('node:fs/promises').then(m=>m.readFile(join(root,team.id+'.json'),'utf8'))),team);
});
