import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {TeamPlanStart} from '../src/team-plan-start.mjs';
import {sendPanelPlanStart} from '../src/panel-plan-start.mjs';

async function fixture(source='panel-user-action'){
 const root=await mkdtemp(join(tmpdir(),'plan-start-')),engine=new LeaderEngine({root,observer:{async inspect(){throw Error('Must not start or inspect a native model');}}});
 let team=await engine.planOnce('owner',{cwd:root,threadId:'leader'},{goal:'Implement the confirmed project goal',execute:true,taskPlanning:'leader',approvalMode:'required',memberStartup:'on-demand',plan:{members:[{id:'dev',role:'Dev',responsibility:'Implement',reason:'Delivery',writeScopes:['src']},{id:'qa',role:'QA',responsibility:'Review independently',reason:'Verification',writeScopes:[]}],tasks:[]}});
 const pending=structuredClone(team);team=(await engine.decidePlan('owner',team.id,team.revision,{planVersion:team.planReview.version,planHash:team.planReview.hash,requestId:randomUUID(),note:'User confirmed this team',source},'approve')).team;
 const starts=new TeamPlanStart(root),args={planVersion:team.planReview.version,planHash:team.planReview.hash,requestId:randomUUID()};return {root,engine,team,pending,starts,args};
}

test('concurrent panels offer only one start message per approved initial version, without changing the team',async()=>{
 const f=await fixture(),before=await f.engine.native('owner',f.team.id),other=new TeamPlanStart(f.root);
 const replies=await Promise.all([f.starts.request('owner',f.team,f.args),other.request('owner',f.team,{...f.args,requestId:randomUUID()})]);
 assert.equal(replies.filter(r=>r.firstOffer).length,1);const offered=replies.find(r=>r.firstOffer);assert.equal(offered.message.role,'user');assert.ok(offered.message.content[0].text.includes(f.team.id));assert.ok(offered.message.content[0].text.includes(f.team.planReview.hash));assert.equal(offered.message.content[0].text.includes(f.team.goal),false);
 await f.starts.record('owner',f.team,{requestId:offered.requestId,status:'host-accepted'});const replay=await other.request('owner',f.team,{...f.args,requestId:randomUUID()});assert.equal(replay.firstOffer,false);assert.equal(replay.message,undefined);assert.equal(replay.status,'host-accepted');assert.deepEqual(await f.engine.native('owner',f.team.id),before);
});

test('only a current panel-approved active initial team can request startup',async()=>{
 const f=await fixture();await assert.rejects(()=>f.starts.request('owner',f.pending,f.args),/approved/);await assert.rejects(()=>f.starts.request('foreign',f.team,f.args),/another conversation/);await assert.rejects(()=>f.starts.request('owner',f.team,{...f.args,planVersion:9}),/current initial/);
 const stopped=structuredClone(f.team);stopped.executionControl={status:'stopping'};await assert.rejects(()=>f.starts.request('owner',stopped,f.args),/stopped/);
 const expanded=structuredClone(f.team);expanded.planReview.scope='expansion';await assert.rejects(()=>f.starts.request('owner',expanded,f.args),/initial/);
 const stale=structuredClone(f.team);stale.planReview.approval.hash='0'.repeat(64);await assert.rejects(()=>f.starts.request('owner',stale,f.args),/approved/);
 const chat=await fixture('leader-recorded-user-confirmation');await assert.rejects(()=>chat.starts.request('owner',chat.team,chat.args),/panel/);
 const started=structuredClone(f.team);started.tasks=[{attempts:[{id:'real-existing-attempt'}]}];assert.equal((await f.starts.request('owner',started,f.args)).status,'already-started');
 assert.equal(await f.starts.read('owner',f.team),null);
});

test('only an explicit failed host response allows one user retry; unknown and success remain immutable',async()=>{
 const f=await fixture();await f.starts.request('owner',f.team,f.args);await f.starts.record('owner',f.team,{requestId:f.args.requestId,status:'failed'});
 const retry={...f.args,requestId:randomUUID(),retryOf:f.args.requestId};const offered=await f.starts.request('owner',f.team,retry);assert.equal(offered.firstOffer,true);assert.equal((await f.starts.request('owner',f.team,retry)).firstOffer,false);
 await f.starts.record('owner',f.team,{requestId:retry.requestId,status:'unknown'});assert.equal((await f.starts.request('owner',f.team,{...retry,requestId:randomUUID(),retryOf:retry.requestId})).firstOffer,false);await assert.rejects(()=>f.starts.record('owner',f.team,{requestId:retry.requestId,status:'host-accepted'}),/already recorded/);await assert.rejects(()=>f.starts.record('foreign',f.team,{requestId:retry.requestId,status:'unknown'}),/another conversation/);
});

test('the UI never offers starts without host capability, never retries ambiguous sends, and never calls the host from a read',async()=>{
 const f=await fixture();let calls=0,sends=0;const args={teamId:f.team.id,...f.args},call=async(name,a)=>{calls++;return name==='request_team_plan_start'?f.starts.request('owner',f.team,a):f.starts.record('owner',f.team,a);};
 assert.equal((await sendPanelPlanStart({sendMessage(){throw Error('Unsupported');}},call,args)).status,'unsupported');assert.equal(calls,0);
 const app={getHostCapabilities:()=>({message:{}}),async sendMessage(){sends++;throw Error('Lost response');}};assert.equal((await sendPanelPlanStart(app,call,args)).status,'unknown');assert.equal((await sendPanelPlanStart(app,call,{...args,requestId:randomUUID()})).status,'unknown');assert.equal(sends,1);assert.equal((await f.starts.read('owner',f.team)).status,'unknown');assert.equal(sends,1);
});

test('leaving a selected plan prevents the send; receipt loss after acceptance never repeats it',async()=>{
 const f=await fixture();let sends=0;const app={getHostCapabilities:()=>({message:{}}),async sendMessage(){sends++;return {};}};const args={teamId:f.team.id,...f.args},call=(name,a)=>name==='request_team_plan_start'?f.starts.request('owner',f.team,a):f.starts.record('owner',f.team,a);
 assert.equal((await sendPanelPlanStart(app,call,args,{isCurrent:()=>false})).status,'failed');assert.equal(sends,0);
 const retry={...args,requestId:randomUUID(),retryOf:args.requestId};const lost=async(name,a)=>{if(name==='record_team_plan_start')throw Error('Controlled receipt loss');return call(name,a);};const accepted=await sendPanelPlanStart(app,lost,retry);assert.equal(accepted.status,'host-accepted');assert.equal(accepted.receiptSaved,false);assert.equal((await sendPanelPlanStart(app,call,retry)).status,'reserved');assert.equal(sends,1);
});
