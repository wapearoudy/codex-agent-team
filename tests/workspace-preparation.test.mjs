import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,truncate} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {prepareWorkspace} from '../src/workspace-preparation.mjs';
const exec=promisify(execFile);
test('large historical build logs are excluded before file-budget checks, with an explicit receipt',()=>fixture(async(root,put)=>{
 await put('audit/old/maven-after-fixtures.log','');await truncate(join(root,'audit/old/maven-after-fixtures.log'),38518143);
 await put('src/main.ts','export {}');await put('audit/old/acceptance.md','required evidence');
 const s=await prepareWorkspace(root);assert.ok(s.files['src/main.ts']);assert.ok(s.files['audit/old/acceptance.md']);assert.equal(s.files['audit/old/maven-after-fixtures.log'],undefined);
 assert.deepEqual(s.preparation.excludedGeneratedLogs,[{path:'audit/old/maven-after-fixtures.log',reason:'generated-execution-log',bytes:38518143}]);
}));
test('fixture logs and Git tracked audit logs remain inputs',()=>fixture(async(root,put)=>{
 await exec('git',['init','--quiet',root],{windowsHide:true});await put('audit/maven.log','tracked evidence');await put('tests/fixtures/build.log','fixture');await put('src/parser/example.log','source resource');await put('audit/debug.log','generated');
 await exec('git',['-C',root,'add','audit/maven.log'],{windowsHide:true});
 const s=await prepareWorkspace(root);for(const p of ['audit/maven.log','tests/fixtures/build.log','src/parser/example.log'])assert.ok(s.files[p]);assert.ok(!s.files['audit/debug.log']);
}));
async function fixture(fn){const root=await mkdtemp(join(tmpdir(),'team-prepare-'));const put=async(p,body)=>{await mkdir(dirname(join(root,p)),{recursive:true});await writeFile(join(root,p),body);};try{await fn(root,put);}finally{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.match(root,/team-prepare-/);await rm(root,{recursive:true});}}
test('non-Git project preserves large assets, source, lockfiles and evidence without a manual file list',()=>fixture(async(root,put)=>{
 await put('src/main.js','export {}');await put('public/banner.png',Buffer.alloc(700*1024));await put('docs/acceptance.md','required');await put('audit/result.json','{}');await put('package.json',JSON.stringify({scripts:{test:'vitest'},devDependencies:{vitest:'1'}}));await put('package-lock.json','{}');await put('.npm-cache/cache','irrelevant');
 const s=await prepareWorkspace(root);assert.ok(s.files['public/banner.png']);assert.ok(s.files['package-lock.json']);assert.ok(s.files['audit/result.json']);assert.ok(!s.files['.npm-cache/cache']);assert.equal(s.preparation.source,'filesystem');assert.equal(s.preparation.validationReady,false);assert.equal(s.preparation.issues[0].kind,'dependencies-not-materialized');
}));
test('Git discovery includes tracked ignored assets and untracked code, excludes ignored runtime output',()=>fixture(async(root,put)=>{
 await exec('git',['init','--quiet',root],{windowsHide:true});await put('.gitignore','*.log\n');await put('fixture.log','required tracked fixture');await exec('git',['-C',root,'add','-f','fixture.log'],{windowsHide:true});await put('runtime.log','ignored');await put('src/new.ts','export {}');
 const s=await prepareWorkspace(root);assert.ok(s.files['fixture.log']);assert.ok(s.files['src/new.ts']);assert.ok(!s.files['runtime.log']);assert.equal(s.preparation.source,'git-tracked-and-unignored');
}));
test('nested packages are all discovered and malformed manifests are not reported ready',()=>fixture(async(root,put)=>{
 await put('packages/a/package.json','{"scripts":{"test":"node test.mjs"}}');await put('packages/a/test.mjs','');await put('packages/b/package.json','{broken');await put('shared/types.ts','export {}');
 const s=await prepareWorkspace(root);assert.equal(s.preparation.packages[0].manifest,'packages/a/package.json');assert.deepEqual(s.preparation.packages[0].scripts,['test']);assert.ok(s.files['shared/types.ts']);assert.equal(s.preparation.validationReady,false);assert.equal(s.preparation.issues[0].path,'packages/b/package.json');
}));

test('module selection follows declared write scopes and preserves parent build context',()=>fixture(async(root,put)=>{
 await put('current/app/pom.xml','<project/>');await put('current/app/src/main.java','class Main {}');await put('legacy/unused.bin',Buffer.alloc(17*1024*1024));await put('README.md','root context');
 const s=await prepareWorkspace(root,{writeScopes:['current/app/src']});assert.ok(s.files['current/app/src/main.java']);assert.ok(s.files['README.md']);assert.ok(!s.files['legacy/unused.bin']);assert.ok(s.preparation.inputRoots.includes('current/app'));
}));
test('historical archives are classified but tracked and required inputs win',()=>fixture(async(root,put)=>{
 await put('audit/old/core.jar','old artifact');await put('audit/owned/core.jar','task input');await put('src/credentials.ts','export const name="credential field"');await put('.env.example','KEY=example');await put('.env','synthetic-test-secret');
 const s=await prepareWorkspace(root,{writeScopes:['audit/owned']});assert.ok(!s.files['audit/old/core.jar']);assert.ok(s.files['audit/owned/core.jar']);assert.ok(s.files['src/credentials.ts']);assert.ok(s.files['.env.example']);assert.ok(!s.files['.env']);
}));
