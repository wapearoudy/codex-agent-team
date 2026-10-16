import test from 'node:test';
import assert from 'node:assert/strict';
import {assertContractDelivery} from '../src/team-quality.mjs';
import {verificationCommandMatches,contractCommandEvidence,initializationBinding,compoundVerificationBinding} from '../src/verification-command.mjs';

const observed=(command,expected='npm run typecheck',record={})=>assertContractDelivery(
  {kind:'work',acceptanceCriteria:[{id:'check'}],contract:{verify:[expected]}},
  {writeScopes:[]},JSON.stringify({summary:'Controlled fixture',changedPaths:[],acceptanceResults:[{criterionId:'check',status:'PASS',evidence:'Fixture evidence'}]}),
  [{command,status:'completed',exitCode:0,...record}]
).verifiedCommands[0].observed;

test('native PowerShell logging wrapper preserves the exact captured exit and workspace',()=>{
  const required='node integrations/claude-code/verify-replay.mjs evidence/native.json evidence/inputs.json';
  const wrap=script=>'"C:\\\\native\\\\pwsh.exe" -Command '+"'"+script+"'";
  const actual=wrap(required+' *> evidence/native.log\n$taskExit = $LASTEXITCODE\nWrite-Output "Replay exit=$taskExit; log=evidence/native.log"\nexit $taskExit');
  assert.equal(verificationCommandMatches(actual,required,{cwd:'E:\\project',workspace:'E:\\project'}),true);
  assert.equal(verificationCommandMatches(actual,required,{cwd:'E:\\other',workspace:'E:\\project'}),false);
  for(const exitCode of [1,null])assert.equal(contractCommandEvidence([required],[{command:actual,cwd:'E:\\project',status:'completed',exitCode}],{workspace:'E:\\project'})[0].observed,false);
});
test('PowerShell wrapper cannot hide failure, execute extra commands or echo a claimed check',()=>{
  const required='node verify.mjs',wrap=script=>"pwsh -Command '"+script+"'";
  const valid=required+' > evidence/native.log 2>&1; $code = $LASTEXITCODE; exit $code';
  assert.equal(verificationCommandMatches(wrap(valid),required),true);
  for(const bad of [valid.replace('exit $code','exit 0'),valid.replace('$LASTEXITCODE','0'),valid.replace('exit $code','$code=0; exit $code'),valid.replace('exit $code','node other.mjs; exit $code'),valid.replace(required,'echo '+required),valid.replace(required,required+' | echo success'),valid.replace('exit $code','Write-Output "$(node verify.mjs)"; exit $code'),valid.replace('evidence/native.log','$unknown')])assert.equal(verificationCommandMatches(wrap(bad),required),false,bad);
});

test('PowerShell exit capture rejects automatic variables, including discard and boolean constants',()=>{
  const required='node scripts/verify-host-execution.mjs --host opencode --live';
  const wrap=name=>"pwsh -Command '"+required+'; $'+name+' = $LASTEXITCODE; exit $'+name+"'";
  for(const name of ['null','NuLl','true','false','LASTEXITCODE','Error','Host','HOME','PWD','PID','PSItem','_','args','input','Matches','this'])assert.equal(verificationCommandMatches(wrap(name),required),false,name);
  for(const name of ['taskExit','nativeExitCode','code'])assert.equal(verificationCommandMatches(wrap(name),required),true,name);
});
test('PowerShell native result metadata cannot replace or modify the captured command exit',()=>{
  const required='node scripts/verify-host-execution.mjs --host opencode --live';
  const metadata="[pscustomobject]@{attemptMarker='TEAM_WORKSPACE_ATTEMPT:proof';command='"+required+"';exitCode=$nativeExitCode;at=[DateTime]::UtcNow.ToString('o');log='evidence/native.log'} | ConvertTo-Json -Compress | Set-Content -LiteralPath 'evidence/result.json' -Encoding utf8";
  const wrap=middle=>{const script=required+' *> evidence/native.log; $nativeExitCode = $LASTEXITCODE; '+middle+'; exit $nativeExitCode';return 'pwsh -Command '+"'"+script.replaceAll("'","'\"'\"'")+"'";};
  assert.equal(verificationCommandMatches(wrap(metadata),required),true);
  for(const bad of [metadata.replace('exitCode=$nativeExitCode','exitCode=0'),metadata.replace("command='"+required+"'","command='node different.mjs'"),metadata.replace("at=[DateTime]::UtcNow.ToString('o')",'at=$(node different.mjs)'),metadata.replace('evidence/result.json','src/result.json'),metadata+'; $nativeExitCode=0',metadata.replace('ConvertTo-Json -Compress','node different.mjs')])assert.equal(verificationCommandMatches(wrap(bad),required),false,bad);
});

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

test('declared initialization preserves exact argv, cwd and failure semantics without granting implicit PASS',()=>{
  const required='cd /project && env JAVA_HOME=/jdk mvn test -Dtest=*Requirement*Test,LegacyTest',setup=[". '/tmp/exact.env'",'python3 audit/warm.py'];
  const command=`/bin/zsh -lc 'cd /project && . /tmp/exact.env && python3 audit/warm.py && env JAVA_HOME=/jdk mvn test "-Dtest=*Requirement*Test,LegacyTest" > "$LOG" 2>&1'`;
  const verificationBinding=initializationBinding(command,required,{cwd:'/project',workspace:'/project',initializationCommands:setup});assert.ok(verificationBinding);
  const row={command,cwd:'/project',status:'completed',exitCode:0,source:'reconciled-native-command',verificationBinding};
  assert.equal(contractCommandEvidence([required],[row],{workspace:'/project'})[0].observed,true);
  assert.equal(contractCommandEvidence([required],[{...row,verificationBinding:undefined}],{workspace:'/project'})[0].observed,false);
  assert.equal(contractCommandEvidence([required],[{...row,verificationBinding:{...verificationBinding,hash:'a'.repeat(64)}}],{workspace:'/project'})[0].observed,false);
  for(const suffix of [' || true','; echo PASS',' | cat',' && echo PASS'])assert.equal(initializationBinding(command.slice(0,-1)+suffix+"'",required,{cwd:'/project',workspace:'/project'}),null);
  for(const script of ['echo mvn test && env JAVA_HOME=/jdk mvn test -Dtest=*Requirement*Test,LegacyTest','source "$ENV" && env JAVA_HOME=/jdk mvn test -Dtest=*Requirement*Test,LegacyTest','cd /other && . /tmp/exact.env && env JAVA_HOME=/jdk mvn test -Dtest=*Requirement*Test,LegacyTest'])assert.equal(initializationBinding(script,required,{cwd:'/project',workspace:'/project'}),null);
  assert.equal(initializationBinding(command,required,{cwd:'/project',workspace:'/project',initializationCommands:['. /other.env','python3 audit/warm.py']}),null);
  assert.equal(initializationBinding(command,required.replace('LegacyTest','OtherTest'),{cwd:'/project',workspace:'/project'}),null);
  for(const bad of [{status:'failed',exitCode:1},{status:'completed',exitCode:null},{status:'inProgress',exitCode:null}])assert.equal(contractCommandEvidence([required],[row,{...row,...bad,verificationBinding:undefined}],{workspace:'/project'})[0].observed,false);
});


test('direct edit then verification chains preserve terminal argv, native cwd, outcomes and full evidence',()=>{
  const required='python3 -m unittest discover -s . -p "test*.py" -v';
  const chain="python3 -c 'p=\"test_extra.py\"; s=open(p).read().replace(\"old\", \"new\"); open(p,\"w\").write(s)' && "+required;
  const wrap=s=>"/bin/zsh -lc "+JSON.stringify("/bin/zsh -c '"+s.replaceAll("'","'\\''")+"' > '/project/log.txt' 2>&1");
  const options={cwd:'/project',workspace:'/project'};
  for(const actual of [chain,wrap(chain),"cd /project && "+chain,"node -e 'require(\"fs\").writeFileSync(\"a\",\"b\")' && "+required]){
    assert.ok(compoundVerificationBinding(actual,required,options),actual);
    const row={command:actual,cwd:'/project',commandId:'native',turnId:'own',status:'completed',exitCode:0};
    const evidence=contractCommandEvidence([required],[row],options)[0];
    assert.equal(evidence.observed,true);assert.equal(evidence.match,'direct-compound');assert.equal(evidence.hostCommand,actual);assert.equal(evidence.commandId,'native');assert.equal(evidence.turnId,'own');
    for(const bad of [{status:'failed',exitCode:1},{status:'completed',exitCode:null},{status:'inProgress',exitCode:null}]){
      assert.equal(contractCommandEvidence([required],[row,{...row,...bad}],options)[0].observed,false);
      assert.equal(contractCommandEvidence([required],[{...row,...bad},row],options)[0].observed,true);
    }
    for(const cwd of [undefined,'relative','/other'])assert.equal(compoundVerificationBinding(actual,required,{cwd,workspace:'/other-target'}),null);
  }
  for(const bad of [chain+' && true',chain+'; true',chain+' || true',chain+' | cat',chain+' &',chain.replace(' && ','; '),chain.replace(' && ',' || '),"python3 -c 'print(\""+required+"\")'", "sh -c 'true' && "+required,"source /tmp/setup && "+required,"export PATH=/evil && "+required,"python3 -c \"$CODE\" && "+required,"python3 -c 'pass' && cd /other && "+required,"python3 -c 'pass' && echo '"+required+"'",chain.replace(' -v',' -q')])assert.equal(compoundVerificationBinding(bad,required,options),null,bad);
});

test('literal test-runner argv accepts quote spelling, never expansion, a different cwd or a hidden failure',()=>{
 const required='python3 -m unittest discover -s . -p "test*.py" -v',actual="python3 -m unittest discover -s . -p 'test*.py' -v",options={cwd:'/project',workspace:'/project'};
 assert.equal(verificationCommandMatches(actual,required,options),true);
 const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
 const wrapped='/bin/zsh -lc '+quote('/bin/zsh -c '+quote(actual)+" > '/tmp/verification.log' 2>&1");
 assert.equal(verificationCommandMatches(wrapped,required,options),true);
 assert.equal(contractCommandEvidence([required],[{command:wrapped,cwd:'/project',status:'completed',exitCode:0}],{workspace:'/project'})[0].observed,true);
 for(const exitCode of [1,null])assert.equal(contractCommandEvidence([required],[{command:wrapped,cwd:'/project',status:'completed',exitCode}],{workspace:'/project'})[0].observed,false);
 for(const bad of [actual.replace("'test*.py'",'test*.py'),actual.replace("'test*.py'",'"$pattern"'),actual+' || true','echo '+actual,actual.replace('python3',"'python3 -m unittest'"),actual.replace("'test*.py'","'test_store.py'")])assert.equal(verificationCommandMatches(bad,required,options),false,bad);
 assert.equal(verificationCommandMatches(actual,required,{cwd:'/other',workspace:'/project'}),false);
 assert.equal(verificationCommandMatches(actual,required),false,'unknown cwd cannot gain inferred equivalence');
 assert.equal(verificationCommandMatches(actual,required,{cwd:'C:\\project',workspace:'C:\\project'}),false,'POSIX equivalence must not infer Windows shell rules');
 assert.equal(verificationCommandMatches("'X=1' python3 -V",'X=1 python3 -V',options),false);
});

test('literal all-unittest AND chains authenticate every covered command only on an actual terminal zero',()=>{
 const required='python3 -m unittest test_store -v',extra='python3 -m unittest test_extra_store -v',chain=required+' && '+extra,options={cwd:'/project',workspace:'/project'},quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
 for(const actual of [chain,extra+' && '+required,'/bin/zsh -lc '+quote('/bin/zsh -c '+quote(chain)+" > '/project/original.log' 2>&1")]){
  for(const expected of [required,extra]){assert.ok(compoundVerificationBinding(actual,expected,options));const row={command:actual,cwd:'/project',commandId:'saved-native',turnId:'actual',status:'completed',exitCode:0};assert.equal(contractCommandEvidence([expected],[row],options)[0].observed,true);
   for(const bad of [{status:'failed',exitCode:1},{status:'completed',exitCode:null},{status:'inProgress',exitCode:null}])assert.equal(contractCommandEvidence([expected],[row,{...row,...bad}],options)[0].observed,false);
  }
 }
 for(const bad of [chain+' || true',chain+'; true',chain+' | cat',chain+' && echo PASS',required+' && cd /other && '+extra,required+' && python3 -c '+quote('raise SystemExit(0)'),required+' && '+required,required+' && python3 -m unittest "$SUITE" -v'])assert.equal(compoundVerificationBinding(bad,required,options),null,bad);
 assert.equal(compoundVerificationBinding(chain,required,{cwd:'/other',workspace:'/project'}),null);
});

test('one successful named unittest command covers its explicit original module without rerunning it',()=>{
 const required='python3 -m unittest test_http -v',actual='python3 -m unittest test_http test_extra_http -v',options={cwd:'/project',workspace:'/project'};
 const binding=compoundVerificationBinding(actual,required,options);assert.deepEqual(binding.coverage,{requiredModules:['test_http'],executedModules:['test_http','test_extra_http']});
 for(const command of [actual,"/bin/zsh -lc '"+actual+"'",actual+" > '/saved/log' 2>&1","cd '/project' && "+actual]){
  const record={command,cwd:'/project',commandId:'original-host-command',turnId:'original-turn',status:'completed',exitCode:0};
  const evidence=contractCommandEvidence([required],[record],options)[0];assert.equal(evidence.observed,true);assert.equal(evidence.hostCommand,command);assert.equal(evidence.commandId,'original-host-command');
  for(const newer of [{status:'completed',exitCode:1},{status:'completed',exitCode:null},{status:'inProgress',exitCode:null}])assert.equal(contractCommandEvidence([required],[record,{...record,...newer,commandId:'newer'}],options)[0].observed,false);
 }
 for(const bad of [actual.replace('test_http ','other '),actual+' -k smoke',actual+' -f',actual.replace(' -v',' -q'),actual.replace('python3','python'),actual.replace('test_extra_http','"$SUITE"'),actual.replace('test_extra_http','test_http'),actual+' || true',actual+'; true','echo '+actual,'python3 -m unittest discover -v'])assert.equal(compoundVerificationBinding(bad,required,options),null,bad);
 assert.equal(compoundVerificationBinding(actual,required,{cwd:'/other',workspace:'/project'}),null);
 assert.equal(compoundVerificationBinding(actual,required,{workspace:'/project'}),null);
});
