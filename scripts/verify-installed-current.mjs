import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const threadId=process.argv[2];if(!threadId)throw new Error('Pass the verified current host thread ID; do not enumerate unrelated threads');
const source=resolve('plugins/team-workspace-probe'),{version}=JSON.parse(await readFile(join(source,'plugin.json'),'utf8'));
const installed=join(homedir(),'.codex/plugins/cache/fusion-local/team-workspace-probe',version);
const configPath=join(homedir(),'.codex/config.toml');
const configDigest=async()=>createHash('sha256').update(await readFile(configPath)).digest('hex');
const verificationConfigBefore=await configDigest();
for(const path of ['plugin.json','mcp.json','dist/server.cjs','dist/host.html','skills/team-workspace/SKILL.md','README.md'])assert.deepEqual(await readFile(join(installed,path)),await readFile(join(source,path)));
const manifest=JSON.parse(await readFile(join(installed,'mcp.json'),'utf8'));
const client=new Client({name:'installed-package-check-not-desktop-ui',version},{capabilities:{}});
const transport=new StdioClientTransport({command:process.execPath,args:[join(installed,'dist/server.cjs')],env:{...process.env,...manifest.mcpServers['team-workspace-probe'].env},stderr:'pipe'});
try{
 await client.connect(transport);const {tools}=await client.listTools();assert.ok(tools.some(t=>t.name==='recover_team_integration'));assert.ok(!tools.some(t=>t.name==='select_team_project'));
 const opened=await client.callTool({name:'open_team_workspace',arguments:{},_meta:{threadId}});assert.ok(!opened.isError,JSON.stringify(opened.content));assert.equal(opened.structuredContent.version,version);assert.equal(opened.structuredContent.context.cwd.toLowerCase(),resolve('.').toLowerCase());
 const configHash=await configDigest();const upgrade=JSON.parse(await readFile(`evidence/upgrade-${version}.json`,'utf8'));
 assert.equal(upgrade.configBefore,upgrade.configAfter,'Staging must preserve host config');
 assert.equal(configHash,verificationConfigBefore,'This verification must preserve host config');
 const result={observedAt:new Date().toISOString(),kind:'installed-package-protocol-and-real-host-metadata-not-desktop-ui',status:'PASS',version,filesMatchSource:true,toolCount:tools.length,context:opened.structuredContent.context,configHash,configUnchangedDuringVerification:true,stagingConfigUnchanged:true,configMatchesInstallationBaseline:configHash===upgrade.configAfter,installationConfigHash:upgrade.configAfter,modelStarted:false};
 const evidencePath=`evidence/install-v${version}-${Date.now()}.json`;
 await writeFile(evidencePath,JSON.stringify(result,null,2));console.log(JSON.stringify({evidencePath,...result},null,2));
}finally{await client.close();}
