import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeMembers} from '../src/native-members.mjs';
import {assertContractDelivery} from '../src/team-quality.mjs';
const marker='TEAM_WORKSPACE_ATTEMPT:12345678-1234-1234-1234-123456789abc';
const report={attemptMarker:marker,summary:'Read-only research',changedPaths:[],acceptanceResults:[{criterionId:'R',status:'PASS',evidence:['public SDK','exact signature']}]};
test('format-only evidence resend preserves original bound native turn; changed evidence or tools stay ambiguous',async t=>{
  const cwd=await mkdtemp(join(tmpdir(),'report-resend-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  const turns=[{id:'original',status:'completed',items:[{type:'agentMessage',phase:'final_answer',text:JSON.stringify(report)}]},{id:'resend',status:'completed',items:[{type:'agentMessage',phase:'final_answer',text:JSON.stringify({...report,acceptanceResults:[{...report.acceptanceResults[0],evidence:'public SDK\nexact signature'}]})}]}];
  const thread={id:'child',parentThreadId:'leader',cwd,turns};
  const observer=new NativeMembers({rpcFactory:()=>({async connect(){},async close(){},async call(){return {thread};}}),publicFeed:{async read(){return {events:[],usage:null};}}});t.after(()=>observer.close());
  const run=await observer.inspect('leader',cwd,'child',marker,{boundTurnId:'original'});assert.equal(run.turnId,'original');assert.deepEqual(run.duplicateReportTurnIds,['resend']);assert.equal(run.latestTurnId,'resend');assert.equal(run.outputs[0].text,JSON.stringify(report));
  turns[1].items.push({type:'commandExecution',command:'write'});await assert.rejects(()=>observer.inspect('leader',cwd,'child',marker,{boundTurnId:'original'}),/not uniquely/);turns[1].items.pop();
  turns[1].items[0].text=JSON.stringify({...report,summary:'Different result'});await assert.rejects(()=>observer.inspect('leader',cwd,'child',marker,{boundTurnId:'original'}),/not uniquely/);
});
test('concrete evidence arrays are lossless; empty or mixed evidence cannot satisfy a criterion',()=>{
  const task={contract:{inScope:[],verify:[]},attempts:[{marker}],acceptanceCriteria:[{id:'R'}]},member={writeScopes:[]};
  assert.equal(assertContractDelivery(task,member,JSON.stringify(report)).acceptanceResults[0].evidence,'public SDK\nexact signature');
  for(const evidence of [[],['good',{}],['good',' ']])assert.throws(()=>assertContractDelivery(task,member,JSON.stringify({...report,acceptanceResults:[{criterionId:'R',status:'PASS',evidence}]})),/every acceptance criterion/);
});
