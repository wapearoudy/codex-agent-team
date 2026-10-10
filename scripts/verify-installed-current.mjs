import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const threadId=process.argv[2];if(!threadId)throw new Error('Pass the verified current host thread ID; do not enumerate unrelated threads');
// A host project may contain this repository as a child directory. Verify the
// known host project explicitly rather than assuming the script's cwd is it.
const expectedProject=resolve(process.argv[3]??'.');
const source=resolve('plugins/team-workspace-probe'),{version}=JSON.parse(await readFile(join(source,'plugin.json'),'utf8'));
const installed=join(homedir(),'.codex/plugins/cache/fusion-local/team-workspace-probe',version);
const configPath=join(homedir(),'.codex/config.toml');
const configDigest=async()=>createHash('sha256').update(await readFile(configPath)).digest('hex');
const verificationConfigBefore=await configDigest();
for(const path of ['plugin.json','mcp.json','dist/server.cjs','dist/host.html','skills/team-workspace/SKILL.md','README.md'])assert.ok((await readFile(join(installed,path))).equals(await readFile(join(source,path))),'Installed file differs: '+path);
const manifest=JSON.parse(await readFile(join(installed,'mcp.json'),'utf8'));
const client=new Client({name:'installed-package-check-not-desktop-ui',version},{capabilities:{}});
const transport=new StdioClientTransport({command:process.execPath,args:[join(installed,'dist/server.cjs')],env:{...process.env,...manifest.mcpServers['team-workspace-probe'].env},stderr:'pipe'});
try{
 await client.connect(transport);const {tools}=await client.listTools();assert.ok(tools.some(t=>t.name==='recover_team_integration'));assert.ok(!tools.some(t=>t.name==='select_team_project'));
 const opened=await client.callTool({name:'open_team_workspace',arguments:{},_meta:{threadId}});assert.ok(!opened.isError,JSON.stringify(opened.content));assert.equal(opened.structuredContent.version,version);assert.equal(opened.structuredContent.context.cwd.toLowerCase(),expectedProject.toLowerCase());
 const meta={threadId};const schema=await client.callTool({name:'team_leader',arguments:{operation:'describe',toolName:'plan_team'},_meta:meta});assert.ok(schema.structuredContent.inputSchema);assert.equal(JSON.parse(schema.content[0].text).payload,'structuredContent');
 const cached=await client.callTool({name:'team_leader',arguments:{operation:'describe',toolName:'plan_team',schemaHash:schema.structuredContent.schemaHash},_meta:meta});assert.equal(cached.structuredContent.unchanged,true);assert.equal(cached.structuredContent.inputSchema,undefined);
 for(const name of ['read_team_source','prepare_team_command','read_team_command_log','consume_team_inbox','read_team_peer_message','reconcile_team_verification','reconcile_team_review'])assert.ok(tools.some(t=>t.name===name));
 const reconciliation=await client.callTool({name:'team_leader',arguments:{operation:'describe',toolName:'reconcile_team_verification'},_meta:meta});assert.equal(reconciliation.structuredContent.inputSchema.properties.dryRun.default,true);assert.ok(reconciliation.structuredContent.inputSchema.properties.inputProof);assert.ok(reconciliation.structuredContent.inputSchema.properties.commands);
 const review=await client.callTool({name:'team_leader',arguments:{operation:'describe',toolName:'reconcile_team_review'},_meta:meta});assert.equal(review.structuredContent.inputSchema.properties.dryRun.default,true);assert.ok(review.structuredContent.inputSchema.properties.nonValidationFailures);
 const capabilities=await client.callTool({name:'team_leader',arguments:{operation:'manage_team',arguments:{operation:'capabilities'}},_meta:meta});assert.equal(capabilities.structuredContent.phaseHandoff,'explicit-completed-checkpoint; max-3; clean-context');assert.equal(capabilities.structuredContent.singleCopyModelPayloads,true);
 const configHash=await configDigest();let upgrade;try{upgrade=JSON.parse(await readFile(`evidence/installation-${version}.json`,'utf8'));upgrade.configBefore=upgrade.sourceConfigBefore;upgrade.configAfter=upgrade.sourceConfigAfter;}catch(error){if(error.code!=='ENOENT')throw error;upgrade=JSON.parse(await readFile(`evidence/upgrade-${version}.json`,'utf8'));}
 assert.equal(upgrade.configBefore,upgrade.configAfter,'Staging must preserve host config');
 assert.equal(configHash,verificationConfigBefore,'This verification must preserve host config');
 const result={observedAt:new Date().toISOString(),kind:'installed-package-protocol-and-real-host-metadata-not-desktop-ui',status:'PASS',version,filesMatchSource:true,toolCount:tools.length,context:opened.structuredContent.context,configHash,configUnchangedDuringVerification:true,stagingConfigUnchanged:true,configMatchesInstallationBaseline:configHash===upgrade.configAfter,installationConfigHash:upgrade.configAfter,modelStarted:false,singleCopySchema:true,schemaHashReuse:true,modelToolCount:tools.filter(t=>!t._meta?.ui?.visibility||t._meta.ui.visibility.includes('model')).length,schemaPayloadChars:JSON.stringify(schema.structuredContent).length,schemaReceiptChars:schema.content[0].text.length,cachedSchemaPayloadChars:JSON.stringify(cached.structuredContent).length};
 const evidencePath=`evidence/install-v${version}-${Date.now()}.json`;
 await writeFile(evidencePath,JSON.stringify(result,null,2));console.log(JSON.stringify({evidencePath,...result},null,2));
}finally{await client.close();}
