import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,cp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

async function fixture(t,{accepted=false,scenario='ready',validation='PASS'}={}){
  const root=await realpath(await mkdtemp(join(tmpdir(),'dsh-publish-test-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const name='agent-team-deepseek-harness',version='0.40.12';
  const files=['README.md','cordis.patch.yml','dist/client.js','dist/index.mjs','dist/server.cjs','package.json'];
  for(const path of ['scripts','integrations/deepseek-harness','artifacts/hosts/deepseek-harness/dist','artifacts/npm','evidence'])await mkdir(join(root,path),{recursive:true});
  await cp(new URL('../scripts/dsh-npm.mjs',import.meta.url),join(root,'scripts/dsh-npm.mjs'));
  await writeFile(join(root,'package.json'),JSON.stringify({version}));
  await writeFile(join(root,'integrations/deepseek-harness/package.json'),JSON.stringify({name,version}));
  const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
  const fingerprints=[];
  for(const path of files){await writeFile(join(root,'artifacts/hosts/deepseek-harness',path),path);fingerprints.push({path,sha256:sha256(path)});}
  const archive=join(root,'artifacts/npm',name+'-'+version+'.tgz'),bytes=Buffer.from('verified archive');
  await writeFile(archive,bytes);
  const integrity='sha512-'+createHash('sha512').update(bytes).digest('base64');
  await writeFile(join(root,'evidence/dsh-npm-package-'+version+'.json'),JSON.stringify({name,version,archive,files,fingerprints,sha256:sha256(bytes),integrity}));
  await writeFile(join(root,'evidence/dsh-npm-install-'+version+'.json'),JSON.stringify({status:validation,integrity}));
  if(accepted)await writeFile(join(root,'evidence/dsh-npm-accepted-'+version+'.json'),JSON.stringify({status:'ACCEPTED',name,version,integrity,publisher:'test-publisher'}));
  const cli=join(root,'fake-npm.cjs');
  await writeFile(cli,`const fs=require('node:fs');
    const args=process.argv.slice(2),calls=fs.existsSync('calls.json')?JSON.parse(fs.readFileSync('calls.json')):[];
    calls.push(args);fs.writeFileSync('calls.json',JSON.stringify(calls));
    if(args[0]==='whoami'){console.log('test-publisher');process.exit(0);}
    if(args[0]==='publish'){console.error('Unexpected upload');process.exit(9);}
    if(args[0]!=='view')process.exit(8);
    const views=calls.filter(a=>a[0]==='view').length,scenario=process.env.DSH_PUBLISH_TEST_SCENARIO;
    if(scenario==='processing'&&views===1){console.error('npm error code E404');process.exit(1);}
    console.log(JSON.stringify({name:${JSON.stringify(name)},version:${JSON.stringify(version)},dist:{integrity:scenario==='different'?'sha512-different':${JSON.stringify(integrity)}}}));
  `);
  const run=mode=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['scripts/dsh-npm.mjs',mode],{cwd:root,env:{...process.env,npm_execpath:cli,DSH_PUBLISH_TEST_SCENARIO:scenario}});
    let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{output+=bytes;});
    child.on('error',reject);child.on('close',code=>resolve({code,output}));
  });
  return {root,version,integrity,run,calls:async()=>JSON.parse(await readFile(join(root,'calls.json'),'utf8'))};
}

test('verify waits for first-publication processing without authentication or upload',async t=>{
  const f=await fixture(t,{accepted:true,scenario:'processing'}),result=await f.run('verify');
  assert.equal(result.code,0,result.output);
  assert.deepEqual((await f.calls()).map(args=>args[0]),['view','view']);
  const receipt=JSON.parse(await readFile(join(f.root,'evidence/dsh-npm-published-'+f.version+'.json'),'utf8'));
  assert.equal(receipt.status,'PUBLISHED');assert.equal(receipt.integrity,f.integrity);assert.equal(receipt.verifiedRemoteIntegrity,true);
});
test('publish never uploads an accepted tarball again while registry returns 404',async t=>{
  const f=await fixture(t,{accepted:true,scenario:'processing'}),result=await f.run('publish');
  assert.equal(result.code,0,result.output);
  assert.deepEqual((await f.calls()).map(args=>args[0]),['whoami','view','view']);
});
test('verification rejects another tarball at the same published version',async t=>{
  const f=await fixture(t,{accepted:true,scenario:'different'}),result=await f.run('verify');
  assert.notEqual(result.code,0);assert.match(result.output,/different bytes/);
  await assert.rejects(readFile(join(f.root,'evidence/dsh-npm-published-'+f.version+'.json')),error=>error.code==='ENOENT');
});
test('publication cannot bypass failed native installation validation',async t=>{
  const f=await fixture(t,{validation:'FAIL'}),result=await f.run('publish');
  assert.notEqual(result.code,0);
  await assert.rejects(readFile(join(f.root,'calls.json')),error=>error.code==='ENOENT');
});
