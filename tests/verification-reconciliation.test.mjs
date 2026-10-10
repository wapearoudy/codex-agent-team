import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {LeaderEngine} from '../src/leader-engine.mjs';
import {prepareTeamCommand} from '../src/team-output.mjs';
import {assertContractPass} from '../src/team-quality.mjs';
import {assertEvidenceSnapshot} from '../src/evidence-snapshot.mjs';
import {evidencePage} from '../src/team-evidence.mjs';
import {validateTeam} from '../src/team.mjs';

const hash=s=>createHash('sha256').update(s).digest('hex');
async function fixture(t,{history=false,criterion='PASS',complex=false,prepared=false,manifest=false,whitespace=false}={}){
  const root=await mkdtemp(join(tmpdir(),'verification-reconciliation-')),cwd=join(root,'project');
  await mkdir(join(cwd,'src'),{recursive:true});await writeFile(join(cwd,'src/a.mjs'),'candidate');await writeFile(join(cwd,'checks.json'),'fixture config');
  const runs=new Map(),observer={calls:0,async inspect(parent,project,thread,marker){this.calls++;assert.equal(parent,'leader');assert.equal(project,cwd);const run=runs.get(marker);assert.equal(run.threadId,thread);return structuredClone(run);}};
  const engine=new LeaderEngine({root:join(root,'records'),observer});t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
  const work={id:'work',memberId:'dev',kind:'work',title:'Deliver',goal:'Complete behavior',acceptance:'AC passes',acceptanceCriteria:[{id:'AC',description:'Required behavior'}],dependencies:[],contract:{stage:'implementation',inScope:['src'],outOfScope:[],verify:[`cd ${cwd} && npm test`],coverageOf:[]}};
  const review={id:'review',memberId:'qa',kind:'review',title:'Review',goal:'Independent review',acceptance:'Proof',reviewOfTaskId:'work',dependencies:[{taskId:'work',when:'submitted'}]};
  const team=await engine.planOnce('owner',{threadId:'leader',cwd},{goal:'Reuse the unchanged candidate',execute:true,plan:{members:[{id:'dev',role:'Developer',responsibility:'Implement',reason:'Delivery',writeScopes:['src']},{id:'qa',role:'Reviewer',responsibility:'Independent review',reason:'Proof',writeScopes:[]}],tasks:[work,review,{...work,id:'next',dependencies:[{taskId:'work',when:'accepted'}],contract:undefined,acceptanceCriteria:undefined},{...review,id:'next-review',reviewOfTaskId:'next',dependencies:[{taskId:'next',when:'submitted'}]}]}});
  let s=await engine.claim('owner',team.id,team.revision,'work');const a=s.dispatch,thread=randomUUID(),oldId=randomUUID(),currentId=history?randomUUID():oldId,commandId='exec-'+randomUUID();
  const run={threadId:thread,turnId:oldId,parentThreadId:'leader',status:'inProgress',source:'native-thread-persisted-snapshot',outputs:[],commands:[],observedAt:new Date().toISOString()};runs.set(a.marker,run);
  s=await engine.bind('owner',team.id,s.team.revision,'work',a.attemptId,thread);
  let preparation;
  if(prepared)preparation=await prepareTeamCommand(engine.root,s.team,{cwd,threadId:thread,parentThreadId:'leader'},{taskId:'work',attemptId:a.attemptId,requestId:randomUUID(),command:'npm test',verificationInputs:['checks.json']});
  const command=preparation?.nativeCommand??(complex?`/bin/zsh -lc 'set -e\nsource setup.env\nnpm test > "$LOG" 2>&1'`:'/bin/zsh -lc \'npm test > check.log 2>&1\'');
  const oldCommand={turnId:oldId,command,status:'inProgress',exitCode:null,output:'Original saved output'};
  const map={'src/a.mjs':hash('candidate'),'checks.json':hash('fixture config')};
  const report={attemptMarker:a.marker,summary:'Original delivery is immutable',changedPaths:['src/a.mjs'],verificationInputs:['src'],acceptanceResults:[{criterionId:'AC',status:criterion,evidence:criterion==='PASS'?'Original result':'Original host exit was unknown'}],commandsRun:[{command:'npm test',cwd,exitCode:criterion==='PASS'?0:null}],frozenInputs:{files:map}};
  if(manifest){const body=JSON.stringify({files:map});await writeFile(join(cwd,'input-manifest.json'),body);report.verificationInputManifest='input-manifest.json';report.verificationInputManifestSha256=hash(body);}
  const raw=a.marker+'\n'+JSON.stringify(report)+(whitespace?'\n\n':'');
  const current={...run,turnId:currentId,status:'completed',outputs:[{text:raw,turnId:currentId}],commands:history?[]:[oldCommand]};
  if(history){const predecessor={...run,status:'interrupted',statusEvidence:{status:'interrupted',source:'persisted-turn-aborted'},commands:[oldCommand]};current.turnHistory=[predecessor,{...current}];current.turnAssociation={type:'interrupted-continuation',threadId:thread,marker:a.marker,turnIds:[oldId,currentId],links:[{fromTurnId:oldId,toTurnId:currentId,source:'native-interrupted-continuation'}]};}
  runs.set(a.marker,current);s=await engine.settle('owner',team.id,s.team.revision,'work',a.attemptId);
  const fresh=structuredClone(current),receipt={...oldCommand,commandId,cwd,status:'completed',exitCode:0};
  if(history)fresh.turnHistory[0].commands=[receipt];else fresh.commands=[receipt];runs.set(a.marker,fresh);
  const input={taskId:'work',attemptId:a.attemptId,requestId:randomUUID(),note:'Associate the exact saved host receipt; do not execute tests',dryRun:false,commands:[{turnId:oldId,commandId}],inputProof:prepared?{kind:'prepared-command',requestId:preparation.requestId}:history?{kind:'report-file-map',field:'frozenInputs.files',basePath:'.',roots:['src','checks.json']}:{kind:'submitted-candidate'}};
  const saved=()=>engine.native('owner',team.id);
  async function reviewWork(){let s=await saved(),c=await engine.claim('owner',team.id,s.revision,'review'),d=c.dispatch,thread=randomUUID();const v={attemptMarker:d.marker,summary:'Independent original review',decision:'accept',reason:'Original candidate independently reviewed',checks:[{name:'behavior',criterionId:'AC',status:'PASS',evidence:'Reviewed exact original source and saved test evidence'}],findings:[]};runs.set(d.marker,{threadId:thread,turnId:randomUUID(),parentThreadId:'leader',status:'completed',source:'native-thread-persisted-snapshot',outputs:[{text:JSON.stringify(v)}],commands:[]});s=await engine.bind('owner',team.id,c.team.revision,'review',d.attemptId,thread);return engine.settle('owner',team.id,s.team.revision,'review',d.attemptId);}
  return {root,cwd,engine,team:s.team,runs,observer,original:current,fresh,receipt,report,raw,input,saved,reviewWork,preparation};
}
test('cwd reconciliation previews without mutation, accepts the saved independent review once, and replays across restart',async t=>{
  const f=await fixture(t);const reviewed=await f.reviewWork(),before=await f.saved(),calls=f.observer.calls;
  assert.equal(reviewed.team.tasks[0].status,'submitted');assert.ok(reviewed.team.tasks[1].attempts[0].acceptanceException);
  const preview=await f.engine.reconcileVerification('owner',f.team.id,before.revision,{...f.input,dryRun:true});
  assert.deepEqual(preview.verifiedChecks,[{index:0,observed:true}]);assert.equal(preview.startsCommand,false);assert.deepEqual(await f.saved(),before);
  const fixed=await f.engine.reconcileVerification('owner',f.team.id,before.revision,f.input),after=await f.saved();
  assert.equal(after.tasks[0].status,'accepted');assert.equal(after.tasks[1].status,'accepted');assert.equal(after.requiresTeamWorkspaceVersion,'0.31.0');assert.equal(after.tasks[2].status,'waiting');
  assert.deepEqual(after.tasks[0].attempts[0].observation,before.tasks[0].attempts[0].observation);assert.equal(after.tasks[0].evidence.at(-1).summary,f.raw);assert.equal(after.tasks[1].evidence.at(-1).summary,before.tasks[1].evidence.at(-1).summary);
  assert.equal(f.observer.calls,calls+2); // previews and commit read receipts, never start a model/command
  const cold=new LeaderEngine({root:join(f.root,'records'),observer:f.observer});t.after(()=>cold.close());const count=f.observer.calls;
  const replay=await cold.reconcileVerification('owner',f.team.id,1,f.input);assert.equal(replay.replayed,true);assert.equal(f.observer.calls,count);assert.deepEqual(await f.saved(),after);
  await assert.rejects(()=>cold.reconcileVerification('owner',f.team.id,1,{...f.input,note:'Altered replay'}),/different contents/);
  assert.equal(after.events.filter(e=>e.type==='verification-evidence-reconciled').length,1);assert.equal(after.events.filter(e=>e.type==='reviewer-acceptance-registered').length,1);assert.equal(fixed.preservedOriginals,true);
});
test('completed command inside an interrupted predecessor is reusable only with its unchanged historical input closure',async t=>{
  const f=await fixture(t,{history:true});await f.reviewWork();const before=await f.saved();
  await assert.rejects(()=>f.engine.reconcileVerification('owner',f.team.id,before.revision,{...f.input,inputProof:{kind:'submitted-candidate'}}),/at-run input/);
  const fixed=await f.engine.reconcileVerification('owner',f.team.id,before.revision,f.input),after=await f.saved(),a=after.tasks[0].attempts[0];
  assert.equal(after.tasks[0].status,'accepted');assert.equal(fixed.verifiedChecks[0].observed,true);
  assert.deepEqual(a.turnHistory,before.tasks[0].attempts[0].turnHistory);assert.deepEqual(a.turnAssociation,before.tasks[0].attempts[0].turnAssociation);assert.equal(a.turnHistory[0].commands[0].exitCode,null);
  const r=a.verificationReconciliations[0];assert.equal(r.commands[0].exitCode,0);assert.equal(r.commands[0].turnId,a.turnHistory[0].turnId);assert.equal(r.inputProof.fileCount,2);validateTeam(after);
  let page=evidencePage(after,{taskId:'work',section:'verification',limit:512}),text=page.text;assert.equal(page.hasMore,true);assert.ok(page.text.length<=512);
  while(page.hasMore){page=evidencePage(after,{taskId:'work',section:'verification',limit:512,offset:page.nextOffset,cursor:page.cursor});text+=page.text;}assert.equal(JSON.parse(text)[0].source,'plugin-reconciled-native-verification');
  await writeFile(join(f.cwd,'checks.json'),'changed fixture');await assert.rejects(()=>assertEvidenceSnapshot(after,after.tasks[0]),/Historical verification inputs changed/);
  assert.equal(a.turnHistory.length,2);assert.equal(after.tasks[0].attempts.length,1);assert.equal(after.tasks[1].attempts.length,1);
});
test('a legacy manifest is anchored to its original report digest and all files are rechecked',async t=>{
  const f=await fixture(t,{history:true,manifest:true}),s=await f.saved();
  const proof={kind:'report-manifest',path:'input-manifest.json',sha256:f.report.verificationInputManifestSha256,field:'files',basePath:'.',roots:['src','checks.json']};
  const result=await f.engine.reconcileVerification('owner',f.team.id,s.revision,{...f.input,inputProof:proof});assert.equal(result.verifiedChecks[0].observed,true);assert.equal((await f.saved()).tasks[0].status,'submitted');
  const cold=new LeaderEngine({root:join(f.root,'records'),observer:f.observer});t.after(()=>cold.close());validateTeam(await cold.native('owner',f.team.id));
});
test('missing, changed or incomplete proof and foreign native identities fail without any registration',async t=>{
  for(const kind of ['source','config','new-input','missing-input','unknown-exit','failed-exit','foreign-command','foreign-turn','foreign-directory','foreign-report','foreign-parent','foreign-thread','undeclared-map','manifest-hash','symlink','contract'])await t.test(kind,async t=>{
    const f=await fixture(t,{history:true,manifest:kind==='manifest-hash'});let input=structuredClone(f.input),s=await f.saved();
    if(kind==='source')await writeFile(join(f.cwd,'src/a.mjs'),'changed source');
    if(kind==='config')await writeFile(join(f.cwd,'checks.json'),'changed config');
    if(kind==='new-input'){await writeFile(join(f.cwd,'new-config.json'),'new input');input.inputProof.roots.push('new-config.json');}
    if(kind==='missing-input')await rm(join(f.cwd,'checks.json'));
    const command=f.fresh.turnHistory[0].commands[0];
    if(kind==='unknown-exit')command.exitCode=null;if(kind==='failed-exit')command.exitCode=7;
    if(kind==='foreign-command')input.commands[0].commandId='wrong';if(kind==='foreign-turn')input.commands[0].turnId='wrong';
    if(kind==='foreign-directory')command.cwd=f.root;if(kind==='foreign-parent')f.fresh.parentThreadId='other-leader';if(kind==='foreign-thread')f.fresh.threadId='other-child';
    if(kind==='foreign-report')f.fresh.outputs[0].text='Different report';
    if(kind==='undeclared-map')input.inputProof.field='invented.files';
    if(kind==='manifest-hash')input.inputProof={kind:'report-manifest',path:'input-manifest.json',sha256:'a'.repeat(64),field:'files',roots:['src']};
    if(kind==='symlink'){await rm(join(f.cwd,'checks.json'));await writeFile(join(f.root,'outside'),'fixture config');await symlink(join(f.root,'outside'),join(f.cwd,'checks.json'));}
    if(kind==='contract'){s=(await f.engine.store.update(s.id,'owner',s.revision,t=>{t.tasks[0].contractRevision=2;})).team;}
    const before=await f.saved();await assert.rejects(()=>f.engine.reconcileVerification('owner',f.team.id,s.revision,input));assert.deepEqual(await f.saved(),before);
  });
});
test('a definitive old failure cannot be silently replaced by a fresh successful native record',async t=>{
  const f=await fixture(t,{history:true}),s=await f.saved();
  const changed=await f.engine.store.update(s.id,'owner',s.revision,t=>{t.tasks[0].attempts[0].turnHistory[0].commands[0].exitCode=1;});
  await assert.rejects(()=>f.engine.reconcileVerification('owner',f.team.id,changed.team.revision,f.input),/terminal result conflicts/);
});
test('a recovered exit code never promotes an original BLOCKED criterion or extracts a test from an opaque script',async t=>{
  const f=await fixture(t,{history:true,criterion:'BLOCKED',complex:true});await f.reviewWork();const s=await f.saved();
  const r=await f.engine.reconcileVerification('owner',f.team.id,s.revision,f.input),after=await f.saved();
  assert.equal(r.commands[0].exitCode,0);assert.equal(r.verifiedChecks[0].observed,false);assert.deepEqual(r.nonPassCriteria,[{criterionId:'AC',status:'BLOCKED'}]);
  assert.equal(after.tasks[0].status,'submitted');assert.equal(after.tasks[1].status,'submitted');assert.throws(()=>assertContractPass(after.tasks[0]),/every criterion PASS/);assert.equal(after.tasks[0].evidence.at(-1).summary,f.raw);
});
test('prepared command fingerprints are stable on replay, reject changed inputs, and support a continued attempt',async t=>{
  const f=await fixture(t,{history:true,prepared:true}),s=await f.saved();
  const prepPath=join(f.engine.root,'command-logs',s.id,f.input.attemptId,f.preparation.requestId+'.json'),bytes=await readFile(prepPath);
  const fixed=await f.engine.reconcileVerification('owner',s.id,s.revision,f.input);assert.equal(fixed.verifiedChecks[0].observed,true);assert.ok((await readFile(prepPath)).equals(bytes));
  const g=await fixture(t,{history:true,prepared:true});await writeFile(join(g.cwd,'checks.json'),'changed config');const before=await g.saved();
  await assert.rejects(()=>g.engine.reconcileVerification('owner',g.team.id,before.revision,g.input),/Prepared verification inputs changed/);assert.deepEqual(await g.saved(),before);
});
test('tampered verification audit is rejected by cold persistence validation',async t=>{
  const f=await fixture(t,{history:true}),s=await f.saved();await f.engine.reconcileVerification('owner',f.team.id,s.revision,f.input);const after=await f.saved();
  after.tasks[0].attempts[0].verificationReconciliations[0].commands[0].cwd='/foreign';assert.throws(()=>validateTeam(after),/Invalid historical native verification evidence/);
});
test('future NOT_RUN notes are retained without certifying future work; required missing checks still block',async t=>{
  const f=await fixture(t),s=await f.saved();await f.engine.reconcileVerification('owner',s.id,s.revision,f.input);const candidate=(await f.saved()).tasks[0],a=candidate.attempts[0];
  a.delivery.acceptanceResults.push({criterionId:'future-integration',status:'NOT_RUN',evidence:'Future integration and deployment remain separate tasks'});
  assert.doesNotThrow(()=>assertContractPass(candidate));assert.equal(a.delivery.acceptanceResults.at(-1).status,'NOT_RUN');
  candidate.acceptanceCriteria.push({id:'future-integration',description:'Now explicitly required'});assert.throws(()=>assertContractPass(candidate),/every criterion PASS/);
  candidate.acceptanceCriteria.pop();a.delivery.acceptanceResults.at(-1).status='FAIL';assert.throws(()=>assertContractPass(candidate),/every criterion PASS/);
});
test('native whitespace and an adapted summary do not change the original report used for reconciliation',async t=>{
  const f=await fixture(t,{whitespace:true}),s=await f.saved();
  const adapted=await f.engine.store.update(s.id,'owner',s.revision,t=>{t.tasks[0].evidence.at(-1).summary=JSON.stringify(f.report);});
  const result=await f.engine.reconcileVerification('owner',s.id,adapted.team.revision,f.input);assert.equal(result.verifiedChecks[0].observed,true);
  const after=await f.saved();assert.equal(after.tasks[0].attempts[0].observation.outputs[0].text,f.raw);assert.equal(after.tasks[0].evidence.at(-1).summary,JSON.stringify(f.report));
});
