import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TeamKnowledge} from '../src/team-knowledge.mjs';
import {captureEvidenceSnapshot} from '../src/evidence-snapshot.mjs';

async function fixture(t){const root=await mkdtemp(join(tmpdir(),'knowledge-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,'source.txt'),'first');
  const team={id:'team',projectPath:root,members:[{id:'dev',writeScopes:['source.txt']}],tasks:[{id:'task',memberId:'dev',kind:'work',status:'accepted',contractRevision:1,contract:{inScope:['source.txt']},attempts:[{id:'attempt',acceptance:{}}]}]};
  team.tasks[0].attempts[0].evidenceSnapshot=await captureEvidenceSnapshot(team,team.tasks[0],['source.txt']);
  return {root,team,knowledge:new TeamKnowledge(join(root,'saved'))};}
const input={taskId:'task',text:'Preserve the chosen wire identity.',tags:['identity'],key:'wire',requestId:'request-one'};
test('accepted decision revisions retain sources and retire older revisions without granting authority',async t=>{
  const {knowledge,team}=await fixture(t),first=await knowledge.save(team,input);assert.equal(first.revision,1);
  assert.deepEqual(await knowledge.save(team,input),first);await assert.rejects(()=>knowledge.save(team,{...input,text:'different'}),/identity mismatch/);
  const second=await knowledge.save(team,{...input,text:'Use exact native identity.',requestId:'request-two'});assert.equal(second.revision,2);
  const view=await knowledge.query(team,{query:'identity'});assert.equal(view.entries[0].validity,'retired');assert.equal(view.entries[1].validity,'current-inputs');assert.equal(view.entries[1].freshVerification,false);assert.equal(view.entries[1].authority,'reference-only');
  await knowledge.retire(team,{entryId:second.id,reason:'Contract replaced'});assert.equal((await knowledge.query(team)).entries[1].validity,'retired');
});
test('changed inputs, changed source contract and inaccessible snapshots never count as fresh evidence',async t=>{
  const {knowledge,team,root}=await fixture(t);await knowledge.save(team,input);await writeFile(join(root,'source.txt'),'second');
  assert.equal((await knowledge.query(team)).entries[0].validity,'inputs-changed');await assert.rejects(()=>knowledge.save(team,{...input,requestId:'new'}),/inputs changed/);
  team.tasks[0].contractRevision++;assert.equal((await knowledge.query(team)).entries[0].validity,'source-invalidated');team.tasks[0].contractRevision--;
  knowledge.capture=async()=>{throw new Error('unavailable');};assert.equal((await knowledge.query(team)).entries[0].validity,'UNKNOWN');
});
test('unaccepted, review, superseded and fingerprintless sources cannot be curated; retrieval stays bounded',async t=>{
  const {knowledge,team}=await fixture(t),task=team.tasks[0];for(const change of [{status:'submitted'},{kind:'review'},{supersededBy:'new'}]){const original=structuredClone(task);Object.assign(task,change);await assert.rejects(()=>knowledge.save(team,input),/accepted work/);Object.keys(task).forEach(k=>delete task[k]);Object.assign(task,original);}
  await assert.rejects(()=>knowledge.query(team,{limit:51}),/Invalid knowledge page/);delete task.attempts[0].evidenceSnapshot;await assert.rejects(()=>knowledge.save(team,input),/fingerprint/);
});
