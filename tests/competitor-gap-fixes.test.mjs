import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ObserverQueue} from '../src/observer-queue.mjs';
import {createDshAccumulator,normalizeDshSession} from '../src/host-normalize.mjs';
import {OpenCodeMessages} from '../src/opencode-observer.mjs';
import {buildPanelTaskAppend} from '../src/team-view.mjs';
import {pluginDoctor} from '../src/plugin-doctor.mjs';
import {normalizePolicy} from '../src/team-policy.mjs';
import {policyExpands} from '../src/team-plan-review.mjs';
import {routeLimitBlockers} from '../src/route-concurrency.mjs';
import {projectDiffAudit,acceptedKnowledge} from '../src/project-audit.mjs';
import {execFileSync} from 'node:child_process';
import {TranscriptCache} from '../src/transcript-cache.mjs';

test('dense native events coalesce to one fresh follow-up; every caller waits for it',async()=>{
 const queue=new ObserverQueue();let release;const held=new Promise(r=>release=r);let reads=0;
 const first=queue.publish('child',async()=>{reads++;await held;});
 const followers=Array.from({length:500},()=>queue.publish('child',async()=>{reads++;}));
 assert.equal(queue.entries.size,1);release();await Promise.all([first,...followers]);assert.equal(reads,2);assert.equal(queue.entries.size,0);
 await assert.rejects(queue.publish('child',async()=>{throw new Error('native unavailable');}),/native unavailable/);assert.equal(queue.entries.size,0);
});
test('incremental DSH normalization preserves exact output, usage, commands and terminal evidence',()=>{
 const session={id:'child',header:{cwd:process.cwd(),parentSession:'leader',createdAt:1},inheritedEventCount:0,isOwnSeq:()=>true,requestHeader:()=>({config:{}})};
 const events=[{seq:1,type:'turn/start',data:{turn:1}},{seq:2,type:'user/message',data:{id:'u',content:'contract'}},{seq:3,type:'tool/call',data:{turn:1,callId:'c',name:'bash',arguments:'{"command":"npm test"}'}},{seq:4,type:'tool/result',data:{message:{source:{callId:'c'},content:'PASS'},meta:{exitCode:0}}},{seq:5,type:'assistant/message',data:{turn:1,message:{id:'a',content:'done'},usage:{inputTokens:2,outputTokens:3}}},{seq:6,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}];
 const accumulator=createDshAccumulator(session);for(const event of events)accumulator.append(event);
 assert.deepEqual(accumulator.snapshot(),normalizeDshSession(session,events));assert.equal(accumulator.snapshot().turns[0].status,'completed');assert.equal(accumulator.snapshot().turns[0].usage.totalTokens,5);
});
test('OpenCode event cache updates exact rows and refreshes ambiguous deltas',()=>{
 const cache=new OpenCodeMessages();cache.reset([{info:{id:'u',role:'user',time:{created:1}},parts:[]},{info:{id:'a',role:'assistant',parentID:'u',time:{created:2}},parts:[]}]);
 cache.event({type:'message.part.updated',properties:{part:{id:'p',messageID:'a',type:'text',text:'live'}}});assert.equal(cache.snapshot()[1].parts[0].text,'live');
 cache.event({type:'message.updated',properties:{info:{id:'a',role:'assistant',parentID:'u',finish:'stop',time:{created:2,completed:3}}}});assert.equal(cache.snapshot()[1].parts[0].text,'live');
 cache.event({type:'message.part.updated',properties:{part:{id:'p',messageID:'a'},delta:'tail'}});assert.equal(cache.needsRefresh,true);
 cache.event({type:'message.removed',properties:{messageID:'a'}});assert.equal(cache.snapshot().length,1);
});
test('OpenCode events arriving during a full read cannot be lost to the baseline reset',async()=>{
 const cache=new OpenCodeMessages();let release;const data=new Promise(r=>release=r),read=cache.refresh(()=>data);
 cache.event({type:'message.updated',properties:{info:{id:'a',role:'assistant',parentID:'u',time:{created:2},finish:'stop'}}});cache.event({type:'message.part.updated',properties:{part:{id:'p',messageID:'a',type:'text',text:'fresh'}}});
 release([{info:{id:'u',role:'user',time:{created:1}},parts:[]}]);await read;assert.equal(cache.snapshot()[1].parts[0].text,'fresh');
});
test('provider and model concurrency caps use frozen routes and expansion requires approval',()=>{
 const policy=normalizePolicy({providerConcurrency:{p:1},modelConcurrency:{m:1}}),team={policy,members:[{id:'a',routeSnapshot:{provider:'p',model:'m'}},{id:'b',routeSnapshot:{provider:'p',model:'m'}}],tasks:[{id:'running',memberId:'a',status:'running'}]};
 assert.deepEqual(routeLimitBlockers(team,{id:'next',memberId:'b'}).map(x=>x.code),['provider-limit','model-limit']);assert.equal(policyExpands(policy,{...policy,modelConcurrency:{m:2}}),true);assert.equal(policyExpands(policy,{...policy,modelConcurrency:{m:1}}),false);assert.throws(()=>normalizePolicy({providerConcurrency:{p:0}}),/Invalid/);
});
test('real Git inventory includes tracked, untracked and rename paths without attributing pre-existing changes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'diff-audit-')),git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true});git(['init','-q']);await mkdir(join(root,'src'));await writeFile(join(root,'src/old.txt'),'base');git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','base']);git(['mv','src/old.txt','src/new.txt']);await writeFile(join(root,'extra.txt'),'new');
 const result=await projectDiffAudit({projectPath:root,members:[{id:'dev',writeScopes:['src']},{id:'other',writeScopes:['src']}],tasks:[]});assert.equal(result.attribution,'project-level-unattributed');assert.deepEqual(result.files.map(f=>f.path).sort(),['extra.txt','src/new.txt','src/old.txt']);assert.equal(result.files.find(f=>f.path==='src/new.txt').overlappingWriters,true);assert.equal(result.files.find(f=>f.path==='extra.txt').scopeDeclared,false);
});
test('accepted knowledge exposes provenance without claiming historical evidence is fresh',()=>{
 const result=acceptedKnowledge({id:'team',tasks:[{id:'work',title:'API contract',status:'accepted',kind:'work',acceptance:'Supports query',attempts:[{id:'a',acceptance:{source:'independent-reviewer'},evidenceSnapshot:{fingerprint:'hash'}}]},{id:'pending',title:'Unknown',status:'submitted',kind:'work',attempts:[]}]},{query:'API'});assert.equal(result.total,1);assert.equal(result.entries[0].provenance.attemptId,'a');assert.match(result.entries[0].validity,/not-reverified/);
});
test('Claude transcript cache preserves partial tails and invalidates replacements without unbounded memory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'transcript-cache-')),path=join(root,'agent.jsonl'),cache=new TranscriptCache({maxEntries:1});await writeFile(path,'{"id":"old"}\n{"incomplete":');
 const first=await cache.rows(path);assert.deepEqual(first,[{id:'old'}]);assert.strictEqual(await cache.rows(path),first);
 await writeFile(path,'{"id":"new"}\n');assert.deepEqual(await cache.rows(path),[{id:'new'}]);const other=join(root,'other.jsonl');await writeFile(other,'{"id":"second"}\n');await cache.rows(other);assert.equal(cache.entries.size,1);assert.equal(cache.entries.has(path),false);
});
test('panel strategy emits light, shared standard and strict risk plans without changing goal',()=>{
 const team={activeBatchId:'goal',batches:[{id:'goal',state:'active',qualityMode:'standard'}],members:[{id:'dev',writeScopes:['src']},{id:'qa',writeScopes:[]}]},input={id:'extra',title:'Extra',goal:'Deliver extra behavior',acceptance:'Behavior works',memberId:'dev',reviewerId:'qa',qualityMode:'light'};
 assert.equal(buildPanelTaskAppend(team,input).tasks.length,1);
 const shared=buildPanelTaskAppend(team,{...input,qualityMode:'standard',batchReviewId:'review',dependencies:['previous: delivered']});assert.equal(shared.tasks.length,1);assert.equal(shared.batchReviewId,'review');assert.equal(shared.tasks[0].dependencies[0].when,'delivered');
 assert.throws(()=>buildPanelTaskAppend(team,{...input,riskFlags:['security']}),/criteria/);
 const strict=buildPanelTaskAppend(team,{...input,riskFlags:['security'],criteria:['AC: secure'],verify:['npm test']});assert.equal(strict.tasks[0].qualityMode,'strict');assert.equal(strict.tasks.length,2);
 assert.throws(()=>buildPanelTaskAppend({...team,batches:[{id:'goal',state:'delivered'}]},input),/main conversation/);
});
test('doctor distinguishes installed and resident versions without starting a model',async()=>{
 const root=await mkdtemp(join(tmpdir(),'plugin-doctor-')),dir=join(root,'plugins/cache/fusion-local/team-workspace-probe/0.38.0');await mkdir(dir,{recursive:true});await writeFile(join(dir,'plugin.json'),JSON.stringify({name:'team-workspace-probe',version:'0.38.0'}));
 const result=await pluginDoctor({version:'0.37.0',codexHome:root,context:{threadId:'native'}});assert.equal(result.installedVersion,'0.38.0');assert.equal(result.checks.find(c=>c.id==='installed-version').status,'WARN');assert.equal(result.modelStarted,false);assert.equal(result.checks.find(c=>c.id==='model-access').status,'UNKNOWN');
});
