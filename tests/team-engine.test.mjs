import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {TeamEngine} from '../src/team-engine.mjs';
import {capture,changes,applyChanges} from '../src/workspaces.mjs';

// Deterministic adapter tests. These exercise real files/store/engine, not real model execution.
class Adapter extends EventEmitter{
  records=[];
  async list(owner){return structuredClone(this.records.filter(r=>r.scope===owner));}
  async startMember(input){const r={...input,runId:randomUUID(),threadId:randomUUID(),turnId:randomUUID(),status:'inProgress',connection:'connected',outputs:[],events:[],lastObservedAt:new Date().toISOString()};this.records.push(r);return r;}
  async stop(owner,id){const r=this.records.find(r=>r.scope===owner&&r.runId===id);r.stopState='requested';return r;}
  async close(){}
}
const plan=()=>({members:[{id:'writer',role:'修复',responsibility:'修复计算',reason:'需要修改一个模块',writeScopes:['calc.mjs']},{id:'reviewer',role:'独立检查',responsibility:'核对候选与测试',reason:'实现者不得自验',writeScopes:[]}],tasks:[{id:'fix',kind:'work',title:'修复相加',goal:'正确计算相加',acceptance:'2+3=5',memberId:'writer',priority:1,dependencies:[]},{id:'review',kind:'review',reviewOfTaskId:'fix',title:'独立复核',goal:'复核正确性',acceptance:'实际候选正确',memberId:'reviewer',priority:1,dependencies:[{taskId:'fix',when:'submitted'}]}]});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'team-engine-')),project=join(root,'project');await mkdir(project);await writeFile(join(project,'calc.mjs'),'export const add=(a,b)=>a-b;\n');const adapter=new Adapter(),engine=new TeamEngine({root:join(root,'data'),runtimeFactory:()=>adapter});const team=await engine.create('owner',{id:randomUUID(),owner:'owner',mode:'project-selected',project:{projectId:'project-a',root:project}}, {goal:'修复相加并进行独立复核',plan:plan()});return{root,project,adapter,engine,team};}
async function cleanup(f){await f.engine.close();const path=resolve(f.root);assert.equal(dirname(path),resolve(tmpdir()));assert.match(basename(path),/^team-engine-/);await rm(path,{recursive:true});}
async function finish(f,r,output){r.status='completed';r.outputs=[{turnId:r.turnId,text:JSON.stringify(output)}];await f.engine.queue(f.team.id,()=>f.engine.observe(f.team.id,r));}
test('preparation failure preserves actionable status without consuming dispatches',async()=>{
 const f=await fixture();try{await writeFile(join(f.project,'required.bin'),Buffer.alloc(17*1024*1024));
 await assert.rejects(f.engine.start('owner',f.team.id,f.team.revision),/required.bin/);
 const view=await f.engine.read('owner',f.team.id);assert.equal(view.team.state,'preparation-blocked');assert.match(view.team.preparation.message,/required.bin/);assert.equal(view.team.totalDispatches,0);assert.equal(f.adapter.records.length,0);assert.equal(view.team.original,undefined);
 }finally{await cleanup(f);}
});
test('unstructured completed work is submitted for independent review with real execution identity',async()=>{
  const f=await fixture();try{
    await f.engine.start('owner',f.team.id,f.team.revision);
    const r=f.adapter.records[0];let view=await f.engine.read('owner',f.team.id);
    assert.equal(view.team.tasks[0].attempts[0].agentThreadId,r.threadId);
    assert.equal(view.team.tasks[0].attempts[0].turnId,r.turnId);
    r.status='completed';r.outputs=[{turnId:r.turnId,text:'已检查文件，但未按 JSON 返回。'}];
    await f.engine.queue(f.team.id,()=>f.engine.observe(f.team.id,r));
    view=await f.engine.read('owner',f.team.id);assert.equal(view.team.tasks[0].status,'submitted');assert.equal(view.team.tasks[0].attempts[0].runtimeStatus,'completed');assert.equal(view.team.tasks[0].attempts[0].deliveryFormat,'unstructured');assert.equal(f.adapter.records.length,2);
    const reviewer=f.adapter.records[1];reviewer.status='completed';reviewer.outputs=[{turnId:reviewer.turnId,text:'Looks okay'}];
    await f.engine.queue(f.team.id,()=>f.engine.observe(f.team.id,reviewer));
    view=await f.engine.read('owner',f.team.id);assert.equal(view.team.tasks[1].status,'blocked');assert.equal(view.team.tasks[1].attempts[0].runtimeStatus,'completed');assert.notEqual(view.team.state,'accepted');
  }finally{await cleanup(f);}
});
test('actual candidate files flow through independent review and explicit conflict-safe integration',async()=>{
  const f=await fixture();try{
    assert.equal(f.adapter.records.length,0);await f.engine.start('owner',f.team.id,f.team.revision);
    assert.equal(f.adapter.records.length,1);const impl=f.adapter.records[0];await writeFile(join(impl.cwd,'calc.mjs'),'export const add=(a,b)=>a+b;\n');
    await finish(f,impl,{summary:'Changed addition',evidence:['calc.mjs']});assert.equal(f.adapter.records.length,2);
    assert.match(await readFile(join(f.project,'calc.mjs'),'utf8'),/a-b/);
    const reviewer=f.adapter.records[1];assert.notEqual(reviewer.threadId,impl.threadId);assert.equal(reviewer.sandbox,'workspace-write');assert.deepEqual((await f.engine.read('owner',f.team.id)).team.members.find(m=>m.id==='reviewer').writeScopes,[]);
    assert.match(await readFile(join(reviewer.cwd,'calc.mjs'),'utf8'),/a\+b/);
    await finish(f,reviewer,{summary:'Inspected exact candidate',decision:'accept',reason:'Addition matches acceptance'});
    const view=await f.engine.read('owner',f.team.id);assert.equal(view.team.state,'accepted');assert.ok(!JSON.stringify(view.team).includes('"body"'));
    await f.engine.integrate('owner',f.team.id,view.team.revision);assert.match(await readFile(join(f.project,'calc.mjs'),'utf8'),/a\+b/);
    await assert.rejects(f.engine.read('another-owner',f.team.id),/not found/);
  }finally{await cleanup(f);}
});
test('failed independent review preserves evidence, retries with a new attempt and rejects old results',async()=>{
  const f=await fixture();try{await f.engine.start('owner',f.team.id,f.team.revision);const old=f.adapter.records[0];await finish(f,old,{summary:'First candidate'});await finish(f,f.adapter.records[1],{summary:'Wrong calculation',decision:'rework',reason:'Still subtracts'});assert.equal(f.adapter.records.length,3);const current=await f.engine.read('owner',f.team.id);assert.equal(current.team.tasks[0].attempt,2);assert.equal(current.team.tasks[0].evidence.length,1);assert.notEqual(f.adapter.records[2].attemptId,old.attemptId);await f.engine.observe(f.team.id,old);assert.equal((await f.engine.read('owner',f.team.id)).team.tasks[0].status,'running');}finally{await cleanup(f);}
});
test('source changes cause integration conflict instead of overwriting user edits',async()=>{
  const f=await fixture();try{const before=await capture(f.project);await writeFile(join(f.project,'calc.mjs'),'candidate');const after=await capture(f.project);const delta=changes(before,after,['calc.mjs']);await writeFile(join(f.project,'calc.mjs'),'user new work');await assert.rejects(applyChanges(f.project,delta,join(f.root,'journal')),/manual integration/);assert.equal(await readFile(join(f.project,'calc.mjs'),'utf8'),'user new work');assert.throws(()=>changes(before,after,['docs']),/outside assigned scope/);}finally{await cleanup(f);}
});
