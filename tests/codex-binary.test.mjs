import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,utimes,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {resolveCodexBinary} from '../src/codex-binary.mjs';

test('macOS finds the bundled host executable without a machine-specific manifest and preserves explicit overrides',async()=>{
  const root=await mkdtemp(join(tmpdir(),'team-codex-discovery-'));
  const options={platform:'darwin',home:join(root,'home'),applicationsRoot:join(root,'Applications')};
  const bundled=join(options.applicationsRoot,'ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  const personal=join(options.home,'Applications/Codex.app/Contents/Resources/codex');
  try{
    await assert.rejects(resolveCodexBinary(undefined,options),/TEAM_WORKSPACE_CODEX_BINARY/);
    await mkdir(bundled,{recursive:true});
    await assert.rejects(resolveCodexBinary(undefined,options),/TEAM_WORKSPACE_CODEX_BINARY/);
    await rm(bundled,{recursive:true});await writeFile(bundled,'controlled executable fixture');
    assert.equal(await resolveCodexBinary(undefined,options),bundled);
    const custom=join(root,'custom-codex');await writeFile(custom,'controlled override');
    assert.equal(await resolveCodexBinary(custom,options),custom);
    await rm(bundled);await mkdir(join(options.home,'Applications/Codex.app/Contents/Resources'),{recursive:true});await writeFile(personal,'controlled per-user fixture');
    assert.equal(await resolveCodexBinary(undefined,options),personal);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('Windows executable discovery still selects the newest official installation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'team-codex-windows-'));
  try{
    const bundled=join(root,'AppData/Local/OpenAI/Codex/bin/current/codex.exe');
    const older=join(root,'AppData/Local/OpenAI/Codex/bin/previous/codex.exe');
    await mkdir(join(root,'AppData/Local/OpenAI/Codex/bin/previous'),{recursive:true});await writeFile(older,'controlled old Windows fixture');await utimes(older,1,1);
    await mkdir(join(root,'AppData/Local/OpenAI/Codex/bin/current'),{recursive:true});await writeFile(bundled,'controlled Windows fixture');
    assert.equal(await resolveCodexBinary(undefined,{platform:'win32',home:root}),bundled);
    await assert.rejects(resolveCodexBinary(undefined,{platform:'linux',home:root}),/Configure the supported/);
  }finally{await rm(root,{recursive:true,force:true});}
});
