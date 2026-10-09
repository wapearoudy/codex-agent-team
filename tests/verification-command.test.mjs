import test from 'node:test';
import assert from 'node:assert/strict';
import {assertContractDelivery} from '../src/team-quality.mjs';

const observed=(command,expected='npm run typecheck',record={})=>assertContractDelivery(
  {kind:'work',acceptanceCriteria:[{id:'check'}],contract:{verify:[expected]}},
  {writeScopes:[]},JSON.stringify({summary:'Controlled fixture',changedPaths:[],acceptanceResults:[{criterionId:'check',status:'PASS',evidence:'Fixture evidence'}]}),
  [{command,status:'completed',exitCode:0,...record}]
).verifiedCommands[0].observed;

test('successful host shell wrappers match the complete required script without changing its content',()=>{
  for(const command of [
    'npm run typecheck',"/bin/zsh -lc 'npm run typecheck'",'/bin/bash -c "npm run typecheck"',
    "sh -c 'npm run typecheck'","/usr/bin/zsh --login -c 'npm run typecheck'",
    "bash -l -c 'npm run typecheck'","zsh -cl 'npm run typecheck'",
    "/bin/zsh -lc '/bin/bash -c \"npm run typecheck\"'"
  ])assert.equal(observed(command),true,command);
  const expected='npm test -- src/a.spec.ts src/b.spec.ts';
  assert.equal(observed(`/bin/zsh -lc '${expected}'`,expected),true);
  assert.equal(observed('/bin/zsh -c "printf \\"quoted\\""','printf "quoted"'),true);
  assert.equal(observed("/bin/zsh -c 'printf '\\''it works'\\'''","printf 'it works'"),true);
});

test('mentioned commands, altered scripts, extra operations and dynamic outer shell arguments cannot satisfy verification',()=>{
  for(const command of [
    "echo 'npm run typecheck'","/bin/zsh -lc 'echo npm run typecheck'",
    "/bin/zsh -lc 'npm run typecheck || true'","/bin/zsh -lc 'false; npm run typecheck'",
    "/bin/zsh -lc 'npm run typecheck' && true","/bin/zsh -lc 'npm run typecheck' > result.txt",
    "/bin/zsh -lc 'npm run typecheck' extra","/tmp/zsh -lc 'npm run typecheck'",
    '/bin/zsh -lc "$CHECK_COMMAND"','/bin/zsh -lc "$(echo npm run typecheck)"',
    '/bin/zsh -lc "`echo npm run typecheck`"',"/bin/zsh -lc 'npm run typecheck",
    "/bin/zsh -lc 'npm  run typecheck'","/bin/zsh -lc 'npm run typecheck --other'",
    "/bin/zsh -lc npm*","env CHECK=1 /bin/zsh -lc 'npm run typecheck'",
    "/bin/zsh\n-lc 'npm run typecheck'","/bin/zsh -lc 'npm run typecheck' # comment"
  ])assert.equal(observed(command),false,command);
  for(const record of [{exitCode:1},{exitCode:null},{status:'inProgress'},{status:'failed'}])assert.equal(observed("/bin/zsh -lc 'npm run typecheck'",undefined,record),false);
});

test('quotes and expansions inside the literal required script stay exact, while outer expansion stays unverified',()=>{
  assert.equal(observed("/bin/zsh -c 'printf \"$VALUE\"'",'printf "$VALUE"'),true);
  assert.equal(observed('/bin/zsh -c "printf \\"$VALUE\\""','printf "$VALUE"'),false);
  assert.equal(observed('/bin/zsh -c "printf \\"\\$VALUE\\""','printf "$VALUE"'),true);
  assert.equal(observed('/bin/zsh -c "echo a\\nb"','echo a\\nb'),true);
  assert.equal(observed("/bin/zsh -c 'npm run typecheck'",'npm run typecheck || true'),false);
});
