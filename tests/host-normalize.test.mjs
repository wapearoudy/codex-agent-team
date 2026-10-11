import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOpenCodeSession,normalizeDshSession,publicText,sanitizeThread} from '../src/host-normalize.mjs';
const info={id:'child',directory:process.cwd(),parentID:'leader',time:{created:1}};
const user=id=>({info:{id,role:'user'},parts:[{type:'text',text:id}]});
const assistant=(id,parentID,finished=true)=>({info:{id,parentID,role:'assistant',time:{created:2,...(finished?{completed:3}:{})},...(finished?{finish:'stop'}:{})},parts:[{type:'text',text:id}]});
test('public native outputs redact credentials while preserving JSON and public receipt fields',()=>{
  const raw=JSON.stringify({api_key:'qa-secret',access_token:'qa-secret',password:'qa-secret',refresh_token:'qa-secret',secret:'qa-secret with "escaped" text',exitCode:0});
  const cleaned=publicText(raw);assert.equal(cleaned.includes('qa-secret'),false);
  assert.deepEqual(JSON.parse(cleaned),{api_key:'[redacted]',access_token:'[redacted]',password:'[redacted]',refresh_token:'[redacted]',secret:'[redacted]',exitCode:0});
  assert.equal(publicText('password=qa-secret; ok'), 'password=[redacted]; ok');
  assert.equal(publicText('Bearer qa-secret'), 'Bearer [redacted]');
  const t=sanitizeThread({id:'a',cwd:process.cwd(),turns:[{id:'t',status:'completed',items:[{type:'commandExecution',aggregatedOutput:raw}]}]});
  assert.equal(JSON.parse(t.turns[0].items[0].aggregatedOutput).exitCode,0);
});
test('OpenCode busy/retry and a new unfinished step override old completed output',()=>{
  const messages=[user('u'),assistant('a','u')];
  assert.equal(normalizeOpenCodeSession(info,messages,{type:'idle'}).turns[0].status,'completed');
  for(const type of ['busy','retry']){const t=normalizeOpenCodeSession(info,messages,{type}).turns[0];assert.equal(t.status,'inProgress');assert.equal(t.statusEvidence,undefined);}
  messages.push(assistant('b','u',false));assert.equal(normalizeOpenCodeSession(info,messages,{type:'idle'}).turns[0].status,'unknown');
});
test('OpenCode assistant output associates with its native parent message',()=>{
  const t=normalizeOpenCodeSession(info,[user('first'),user('second'),assistant('a','first')]);
  assert.equal(t.turns[0].items.at(-1).text,'a');assert.equal(t.turns[1].items.length,1);assert.equal(t.turns[1].status,'unknown');
});
test('DSH direct user messages and exact command receipts remain in their turn',()=>{
  const session={id:'child',header:{cwd:process.cwd(),parentSession:'leader',createdAt:1},inheritedEventCount:0,isOwnSeq:()=>true};
  const events=[{type:'turn/start',seq:0,data:{turn:1}},{type:'user/message',seq:1,data:{id:'prompt',content:[{type:'text',text:'MARKER'}]}},{type:'tool/call',seq:2,data:{turn:1,name:'bash',callId:'c',arguments:'{"command":"echo ok"}'}},{type:'tool/result',seq:3,data:{turn:1,message:{source:{callId:'c'},content:[{type:'text',text:'ok'}]},meta:{exitCode:0}}},{type:'turn/end',seq:4,data:{turn:1,reason:{kind:'completed'}}}];
  const t=normalizeDshSession(session,events).turns[0];assert.equal(t.items[0].content[0].text,'MARKER');assert.equal(t.items[1].exitCode,0);assert.equal(t.items[1].commandId,'c');
});
