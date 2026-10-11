import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOpenCodeSession,publicText,sanitizeThread} from '../src/host-normalize.mjs';
test('native startup URL tokens are redacted while model usage remains public',()=>{
 assert.equal(publicText('http://localhost:3000/?token=private-token&view=team'),'http://localhost:3000/?token=[redacted]&view=team');
 assert.equal(publicText('{"inputTokens":12,"token":"private-token"}'),'{"inputTokens":12,"token":"[redacted]"}');
});
test('only a persisted native task-stop receipt can corroborate interrupted Claude state',()=>{
 const thread={id:'child',cwd:process.cwd(),turns:[{id:'turn',status:'interrupted',items:[],statusEvidence:{status:'interrupted',source:'persisted-native-task-stop'}}]};
 assert.equal(sanitizeThread(thread).turns[0].status,'interrupted');
 for(const source of ['native-task-receipt','native-stop-hook-awaiting-receipt','requested']){thread.turns[0].statusEvidence.source=source;assert.equal(sanitizeThread(thread).turns[0].status,'unknown');}
});
test('OpenCode preserves the native failure message without leaking response headers or credentials',()=>{
 const info={id:'child',parentID:'leader',directory:process.cwd(),time:{created:0}};
 const messages=[{info:{id:'user',role:'user'},parts:[{type:'text',text:'check'}]},{info:{id:'assistant',parentID:'user',role:'assistant',error:{name:'APIError',data:{message:'Active subscription required; api_key="private-value"',statusCode:403,responseHeaders:{authorization:'private-header'},responseBody:'private-body'}}},parts:[]}];
 const turn=normalizeOpenCodeSession(info,messages).turns[0];
 assert.equal(turn.status,'failed');assert.equal(turn.statusEvidence.source,'native-message-error');
 assert.match(turn.items.at(-1).text,/Active subscription required/);assert.match(turn.items.at(-1).text,/\[redacted\]/);
 for(const value of ['private-value','private-header','private-body'])assert(!JSON.stringify(turn).includes(value));
});
