import assert from 'node:assert/strict';
import {readFile,writeFile,access,mkdir} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=resolve('.'),built=join(root,'artifacts/hosts/deepseek-harness'),output=join(root,'artifacts/npm'),registry='https://registry.npmjs.org';
const mode=process.argv[2]??'pack',metadata=JSON.parse(await readFile('integrations/deepseek-harness/package.json','utf8'));
const expected=['README.md','cordis.patch.yml','dist/index.mjs','dist/server.cjs','package.json'];
assert.equal(metadata.name,'agent-team-deepseek-harness');assert.equal(metadata.version,JSON.parse(await readFile('package.json','utf8')).version);
let cli;for(const candidate of [process.env.npm_execpath,join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),join(process.env.APPDATA??homedir(),'npm/node_modules/npm/bin/npm-cli.js')].filter(Boolean)){try{await access(candidate);cli=candidate;break;}catch{}}
assert.ok(cli,'Cannot find the existing npm CLI; run this script through npm run');
const npm=(args,options={})=>{const r=spawnSync(process.execPath,[cli,...args],{cwd:root,encoding:'utf8',windowsHide:true,timeout:120000,...options});if(r.status!==0)throw new Error('npm '+args[0]+' failed: '+(r.stderr??r.error?.message??'').slice(-1400));return r;};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
await mkdir(output,{recursive:true});await mkdir('evidence',{recursive:true});
const receipt=join(root,'evidence/dsh-npm-package-'+metadata.version+'.json');
if(mode==='pack'){
  assert.deepEqual(JSON.parse(await readFile(join(built,'package.json'),'utf8')),metadata,'Build the current source before packing');
  const rows=JSON.parse(npm(['pack',built,'--pack-destination',output,'--ignore-scripts','--json']).stdout),pack=rows[0];
  assert.equal(rows.length,1);assert.equal(pack.name,metadata.name);assert.equal(pack.version,metadata.version);
  assert.deepEqual(pack.files.map(f=>f.path).sort(),expected);
  const fingerprints=[];for(const path of expected)fingerprints.push({path,sha256:hash(await readFile(join(built,path)))});
  const archive=join(output,pack.filename),bytes=await readFile(archive);assert.equal('sha512-'+createHash('sha512').update(bytes).digest('base64'),pack.integrity);
  await writeFile(archive+'.sha256',hash(bytes)+'  '+pack.filename+'\n');
  const record={kind:'npm-package-ready-not-published',name:metadata.name,version:metadata.version,archive,sha256:hash(bytes),integrity:pack.integrity,size:bytes.length,files:expected,fingerprints,registry,published:false};
  await writeFile(receipt,JSON.stringify(record,null,2));console.log(JSON.stringify(record));
}else if(mode==='publish'){
  const pack=JSON.parse(await readFile(receipt,'utf8'));assert.equal(pack.name,metadata.name);assert.equal(pack.version,metadata.version);
  assert.deepEqual(pack.files,expected);assert.deepEqual(pack.fingerprints.map(input=>input.path),expected);
  assert.equal(resolve(pack.archive),join(output,metadata.name+'-'+metadata.version+'.tgz'));
  assert.equal(hash(await readFile(pack.archive)),pack.sha256,'Packed bytes changed; repack and validate');
  for(const input of pack.fingerprints)assert.equal(hash(await readFile(join(built,input.path))),input.sha256,'Built package changed; repack and validate');
  const validation=JSON.parse(await readFile('evidence/dsh-npm-install-'+metadata.version+'.json','utf8'));assert.equal(validation.status,'PASS');assert.equal(validation.integrity,pack.integrity,'Native installation validation must cover this tarball');
  const identity=npm(['whoami','--registry='+registry]).stdout.trim();assert.ok(identity);
  const lookup=spawnSync(process.execPath,[cli,'view',metadata.name+'@'+metadata.version,'dist.integrity','--registry='+registry,'--json'],{cwd:root,encoding:'utf8',windowsHide:true,timeout:30000});
  if(lookup.status===0){assert.equal(JSON.parse(lookup.stdout),pack.integrity,'This published version has different bytes; use a new version');console.log('Identical npm version already published; not republishing.');}
  else {assert.ok(lookup.stderr?.includes('E404'),'Cannot verify whether this version already exists');npm(['publish',pack.archive,'--access=public','--tag=latest','--registry='+registry],{stdio:'inherit'});}
  const remote=JSON.parse(npm(['view',metadata.name+'@'+metadata.version,'--registry='+registry,'--json']).stdout);assert.equal(remote.dist.integrity,pack.integrity);assert.equal(remote.version,metadata.version);
  const result={kind:'published-npm-package',status:'PUBLISHED',name:metadata.name,version:metadata.version,url:'https://www.npmjs.com/package/'+metadata.name+'/v/'+metadata.version,registry,integrity:remote.dist.integrity,verifiedRemoteIntegrity:true,publisher:identity};
  await writeFile('evidence/dsh-npm-published-'+metadata.version+'.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}else throw new Error('Use pack or publish');
