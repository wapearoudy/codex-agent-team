import test from 'node:test';
import assert from 'node:assert/strict';
import {assertContractDelivery} from '../src/team-quality.mjs';
import {verificationCommandMatches,contractCommandEvidence} from '../src/verification-command.mjs';

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
test('only a verified host cwd supplies an omitted literal cd; wrong, missing and dynamic directories fail',()=>{
  const required="cd '/project/ui space' && npm run check",actual="/bin/zsh -lc 'npm run check > ../check.log 2>&1'";
  assert.equal(verificationCommandMatches(actual,required,{cwd:'/project/ui space'}),true);
  for(const cwd of [undefined,'relative','/project/other'])assert.equal(verificationCommandMatches(actual,required,{cwd}),false);
  assert.equal(verificationCommandMatches("cd ui && npm run check",required,{cwd:'/project',workspace:'/project'}),false);
  assert.equal(verificationCommandMatches("cd 'ui space' && npm run check",required,{cwd:'/project'}),true);
  assert.equal(verificationCommandMatches('npm test','npm test',{cwd:'/other',workspace:'/project'}),false);
  assert.equal(verificationCommandMatches('npm test','npm test',{workspace:'/project'}),true); // old exact records
  assert.equal(contractCommandEvidence([required],[{command:actual,cwd:'/project/ui space',commandId:'exec-id',turnId:'turn',status:'completed',exitCode:0}])[0].match,'host-working-directory');
  for(const command of ["cd $ROOT && npm run check",'cd /project/ui && false; npm run check',"source setup.env; cd '/project/ui space' && npm run check","cd '/project/ui space' && npm run check || true","/bin/zsh -lc 'npm run check > \"$LOG\" 2>&1'"]){
    assert.equal(verificationCommandMatches(command,required,{cwd:'/project/ui space'}),false,command);
  }
});

test('recorded Windows drive and UNC directories retain their own path identity on every server OS',()=>{
  const actual="/bin/sh -c 'npm test'",cwd=String.raw`C:\work\ui space`,required="cd 'C:/work/ui space' && npm test";
  assert.equal(verificationCommandMatches(actual,required,{cwd}),true);
  assert.equal(verificationCommandMatches("cd 'ui space' && npm test",required,{cwd:'C:/work'}),true);
  for(const wrong of [undefined,'D:/work/ui space','/work/ui space','C:/work/other'])assert.equal(verificationCommandMatches(actual,required,{cwd:wrong}),false);
  assert.equal(verificationCommandMatches("cd 'C:ui space' && npm test",required,{cwd:'C:/work'}),false);
  const unc=String.raw`\\server\share\ui space`;
  assert.equal(verificationCommandMatches(actual,"cd '"+unc+"' && npm test",{cwd:unc}),true);
  assert.equal(verificationCommandMatches(actual,"cd '"+unc+"' && npm test",{cwd:String.raw`\\other\share\ui space`}),false);
});

test('latest matching native outcome overrides old PASS while unrelated commands and wrong directories do not',()=>{
  const good={command:'npm test',commandId:'first',cwd:'/project',status:'completed',exitCode:0};
  for(const bad of [{status:'failed',exitCode:1},{status:'inProgress',exitCode:null},{status:'completed',exitCode:null},{status:'unknown',exitCode:null}]){
    const rows=[good,{...good,commandId:'later',...bad}];assert.equal(contractCommandEvidence(['npm test'],rows,{workspace:'/project'})[0].observed,false);
    assert.equal(contractCommandEvidence(['npm test'],[...rows,{...good,commandId:'recovered'}],{workspace:'/project'})[0].observed,true);
  }
  for(const extra of [{...good,command:'npm lint',exitCode:1},{...good,cwd:'/other',exitCode:1}])assert.equal(contractCommandEvidence(['npm test'],[good,extra],{workspace:'/project'})[0].observed,true);
});
