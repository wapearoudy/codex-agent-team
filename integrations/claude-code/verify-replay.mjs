import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {HostBridge} from '../../src/host-bridge.mjs';
import {matchesNativeHookTurn} from './verify-live.mjs';

// Re-read actual native receipts after a verifier identity mismatch. This never
// launches a model or creates a native receipt, thread, turn or terminal status.
const [runPath,inputPath]=process.argv.slice(2);assert.ok(runPath&&inputPath,'Original native run and pre-run input manifest are required');
const report=JSON.parse(await readFile(runPath,'utf8')),inputs=JSON.parse(await readFile(inputPath,'utf8'));
const host=report.hosts['claude-code'];assert.equal(host.status,'FAIL');assert.match(host.error,/plugin-observed native stopped terminal/);
const changedVerifierInputs=new Set(['integrations/claude-code/verify-live.mjs','tests/cross-host.test.mjs']);
const productionInputs=inputs.files.filter(file=>!changedVerifierInputs.has(file.path));assert.ok(productionInputs.length);
for(const file of productionInputs){const sha256=createHash('sha256').update(await readFile(file.path)).digest('hex');assert.equal(sha256,file.sha256,`Original production input changed: ${file.path}`);}
const events=JSON.parse(await readFile(host.eventsPath,'utf8'));
const nativeChild=events.find(e=>e.kind==='native-child'),initial=events.find(e=>e.kind==='initial-terminal'),resumed=events.find(e=>e.kind==='resumed-terminal'),active=events.find(e=>e.kind==='bridge-active'),stop=events.find(e=>e.kind==='stop-control-request');
assert.ok(nativeChild&&initial&&resumed&&active&&stop);
const bridge=new HostBridge({host:'claude-code',root:host.bridgeRoot});
const thread=await bridge.readThread(nativeChild.childId),parent=await bridge.readThread(nativeChild.parentId),registry=await bridge.store.read(),last=thread.turns.at(-1),state=registry.claudeHookTurns[thread.id];
assert.equal(thread.parentThreadId,nativeChild.parentId);assert.equal(thread.cwd,host.project);assert.equal(parent.cwd,host.project);
assert.equal(Object.values(registry.threads).filter(t=>t.parentThreadId===thread.parentThreadId).length,1);
const routes=new Set(events.filter(e=>e.kind==='init').map(e=>e.model));assert.equal(routes.size,1);
const launches=events.filter(e=>e.kind==='task_started'&&e.taskId===thread.id);assert.equal(launches.length,3);assert.equal(new Set(launches.map(e=>e.toolUseId)).size,3);
const initialTurn=thread.turns.find(t=>t.id===initial.turnId),resumeTurn=thread.turns.find(t=>t.id===resumed.turnId);
assert.equal(initialTurn.status,'completed');assert.ok(JSON.stringify(initialTurn).includes(nativeChild.marker+':initial'));
assert.equal(resumeTurn.status,'completed');assert.notEqual(initialTurn.id,resumeTurn.id);assert.ok(JSON.stringify(resumeTurn).includes(nativeChild.marker+':resumed'));
assert.equal(active.status,'inProgress');assert.equal(stop.childId,thread.id);assert.equal(stop.taskId,thread.id);assert.equal(launches[2].toolUseId,active.turnId);
assert.ok(matchesNativeHookTurn(last,state,active.turnId));assert.equal(state.receiptTurnId,active.turnId);
assert.equal(last.status,'interrupted');assert.equal(last.statusEvidence.source,'persisted-native-task-stop');
const stopped=events.find(e=>e.kind==='task_notification'&&e.taskId===thread.id&&e.toolUseId===active.turnId&&e.status==='stopped');assert.ok(stopped);assert.ok(Date.parse(stopped.at)>=Date.parse(stop.at));
const result={attemptMarker:inputs.attemptMarker,runId:report.runId,status:'PASS',modelStarts:0,reusedActualNativeExecution:true,originalLiveCommandPassed:false,originalRunPath:runPath,originalInputsPath:inputPath,verifiedProductionInputCount:productionInputs.length,changedVerifierInputs:[...changedVerifierInputs],productionVersion:report.version,parentId:thread.parentThreadId,childId:thread.id,project:thread.cwd,route:[...routes][0],turns:[initialTurn,resumeTurn,last].map(t=>({id:t.id,status:t.status,statusEvidence:t.statusEvidence})),stopEvidence:{nativeNotification:stopped,activeHookTurnId:active.turnId,linkedTranscriptTurnId:state.linkedTranscriptTurnId},acceptanceResults:['C1','C2','C3','C4'].map(criterionId=>({criterionId,status:'PASS'})),proofSource:'production bridge read of unchanged original native persisted receipts; no synthetic receipt or process cleanup proof'};
await writeFile('evidence/claude-restored-native-replay.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
