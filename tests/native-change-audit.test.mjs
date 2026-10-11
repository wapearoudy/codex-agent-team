import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {nativeChangeAudit} from '../src/project-audit.mjs';
test('only exact native thread/turn public operations attribute reported file changes and scopes remain advisory',()=>{
  const root=process.cwd(),attempt={id:'a',agentThreadId:'child',turnId:'turn'},team={projectPath:root,members:[{id:'dev',writeScopes:['src']}],tasks:[{id:'t',memberId:'dev',contract:{inScope:['src'],outOfScope:['src/private']},attempts:[attempt]}]},run={attemptId:'a',threadId:'child',turnId:'turn',activity:{source:'native-public-rollout',events:[{type:'file_change',itemId:'native-id',status:'completed',sequence:1,paths:[join(root,'src/a.mjs'),'src/private/key','../external']}]}};
  const audit=nativeChangeAudit(team,[run]);assert.equal(audit.receipts.length,3);assert.equal(audit.receipts[0].withinScope,true);assert.equal(audit.scopeViolations,2);assert.equal(audit.receipts[2].path,'[outside-project]');assert.equal(audit.scopeIsSandbox,false);assert.equal(audit.attribution,'host-reported-operation-only');
  for(const altered of [{threadId:'other'},{turnId:'old'},{activity:{source:'member-report',events:run.activity.events}}]){const invalid=nativeChangeAudit(team,[{...run,...altered}]);assert.equal(invalid.total,0);assert.deepEqual(invalid.unknownAttempts,['a']);}
  run.activity.truncated=true;assert.deepEqual(nativeChangeAudit(team,[run]).unknownAttempts,['a']);
  run.activity.truncated=false;run.activity.events[0].pathsTruncated=true;assert.deepEqual(nativeChangeAudit(team,[run]).unknownAttempts,['a']);
});
