import { readFile, writeFile, mkdir } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
const validator = new Ajv2020({ allErrors: true, strict: false });
addFormats(validator);
const checks = [];
const leaderEntry=await readFile('plugins/team-workspace-probe/dist/leader-entry.js','utf8');
new (Object.getPrototypeOf(async function(){}).constructor)('tools','ALL_TOOLS','text','store','load','notify','exit',leaderEntry);
checks.push({file:'dist/leader-entry.js',status:'PASS',validation:'standalone async syntax; runtime serializable-store behavior tested separately'});
for (const kind of ['plugin','mcp']) {
  const schema = JSON.parse((await readFile(`schemas/${kind}.schema.json`,'utf8')).replace(/^\uFEFF/,''));
  const data = JSON.parse(await readFile(`plugins/team-workspace-probe/${kind}.json`,'utf8'));
  const valid = validator.compile(schema);
  if (!valid(data)) throw new Error(JSON.stringify(valid.errors));
  checks.push({ file:`${kind}.json`,schema:schema.$id,status:'PASS' });
}
const version=JSON.parse(await readFile('package.json','utf8')).version;
for(const host of ['deepseek-harness','claude-code','opencode']){
  const root=`artifacts/hosts/${host}`;
  const metadata=JSON.parse(await readFile(`${root}/${host==='claude-code'?'.claude-plugin/plugin.json':'package.json'}`,'utf8'));
  if(metadata.version!==version)throw new Error(`Native ${host} package version mismatch`);
  await readFile(`${root}/dist/server.cjs`);
  if(host==='claude-code'){
    const hooks=JSON.parse(await readFile(`${root}/hooks/hooks.json`,'utf8'));
    const mcp=JSON.parse(await readFile(`${root}/.mcp.json`,'utf8'));
    if(!hooks.hooks?.PreToolUse||!Object.keys(mcp.mcpServers??{}).length)throw new Error('Claude native hooks/MCP registration missing');
    await readFile(`${root}/hooks/bridge.mjs`);
  }else await readFile(`${root}/dist/index.mjs`);
  if(host==='deepseek-harness'){
    if(metadata.exports?.['./client']!=='./dist/client.js'||metadata.dsh?.client?.platform!=='web'||!Array.isArray(metadata.dsh?.client?.inject)||!metadata.dsh.client.inject.length)throw new Error('DSH native browser client registration missing');
    const client=await readFile(`${root}/dist/client.js`,'utf8');
    if(!client.includes('__ModuleLoader__')||!client.includes('conversation.session.header.actions'))throw new Error('DSH native header slot bundle missing');
  }
  checks.push({host,version,status:'PASS',validation:'package-layout-and-version; native-runtime-checks-separate'});
}
await mkdir('evidence',{recursive:true});
await writeFile('evidence/package-validation.json',JSON.stringify({observedAt:new Date().toISOString(),checks,hostInstallation:'NOT_RUN'},null,2));
console.log('Codex manifests pass Agent Plugins 1.0 schemas; three native host package layouts/versions match. Runtime checks are separate.');
