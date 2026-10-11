// Isolated installed DSH web composition. Native UI creates its actual Agent;
// authenticated ToolRuntime calls exercise engine planning without model turns.
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const runtimeRoot=process.env.DSH_RUNTIME_ROOT??join(process.env.APPDATA,'npm/node_modules/@deepseek-ai/dsh');
const packageRoot=resolve('artifacts/hosts/deepseek-harness');
const evidence=resolve('evidence/native-ui-039');await mkdir(evidence,{recursive:true});
process.env.DSH_HOME=await mkdtemp(join(tmpdir(),'team-native-ui-'));
process.env.TEAM_WORKSPACE_DATA_ROOT=join(process.env.DSH_HOME,'engine');
const load=path=>import(pathToFileURL(join(runtimeRoot,path)).href);
const {runProfile}=await load('lib/profile-boot.js');
const {createLaunchEnvironmentSnapshot}=await load('node_modules/@deepseek-ai/dsh-launch-environment/lib/index.js');
const overlay=join(evidence,'isolated.patch.yml');
await writeFile(overlay,`- insert:\n    - id: team-workspace-ui-proof\n      name: ${JSON.stringify(join(packageRoot,'dist/index.mjs').replaceAll('\\','/'))}\n      inject: [tools, sessions, agents, sessionProjections]\n      config:\n        bridgeRoot: ${JSON.stringify(join(evidence,'bridge').replaceAll('\\','/'))}\n`);
let runtime,ownedAgent;const receipts=[],events=[];
try{
  runtime=await runProfile({environment:createLaunchEnvironmentSnapshot([{source:'process',values:{DSH_HOME:process.env.DSH_HOME}}]),profile:'native-ui-proof',fromDefaultProfile:'web',patchFiles:[overlay],args:['--port','0','--no-open']});
  const metadata=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'));
  const ctx=runtime.ctx;
  const workspace=await ctx.workspaceRegistry.create(resolve('.'),'Team Workspace zero-model verification');
  ctx.on('session/event',(session,event)=>{if(event.type==='turn/start')events.push({sessionId:session.id,type:event.type});});
  const save=async data=>writeFile(join(evidence,'engine-proof.json'),JSON.stringify({kind:'actual-installed-native-engine',isolation:'temporary DSH_HOME and engine data',modelTurns:events.length,receipts,...data},null,2));
  ctx.on('agent/created',async ({agent})=>{
    if(agent.session.header.parentSession)return;
    try{
      assert.equal(ctx.agents.get(agent.id),agent);assert.equal(ctx.sessions.get(agent.id),agent.session);
      const schemas=ctx.tools.schemas(agent),wire=ctx.tools.wireSchemas(agent);
      const call=async(name,args)=>{
        const ptc=!wire.schemas.some(tool=>tool.name===name)&&wire.schemas.some(tool=>tool.name==='run_code')&&schemas.some(tool=>tool.name===name);
        const request=ptc?{name:'run_code',arguments:{code:`return await tools[${JSON.stringify(name)}](${JSON.stringify(args)});`,description:`Zero-model native ${name} engine proof`}}:{name,arguments:args};
        const receipt=await ctx.tools.execute({callId:randomUUID(),...request,agent,signal:new AbortController().signal});
        if(receipt.isError)throw new Error(receipt.error?.message??JSON.stringify(receipt.content));
        const value=ptc?receipt.value?.result:receipt.value;receipts.push({name,operation:args.operation??null,transport:request.name,value});return value;
      };
      const context=await call('get_current_project',{});assert.equal(context.context.threadId,agent.id);
      const planned=await call('team_leader',{operation:'plan_team',arguments:{goal:'Isolated zero-model native engine projection proof',plan:{members:[{id:'proof-member',role:'Native UI verification',responsibility:'Inspect zero-model native projection',reason:'Native UI integration proof',writeScopes:['integrations/deepseek-harness']}],tasks:[]},execute:false,requestId:randomUUID()},responseView:'summary'});
      const teamId=planned.teamId??planned.team?.id;assert.ok(teamId,'Actual engine team identity required');
      const current=await call('open_team_workspace',{});assert.equal(current.nativeProjection.team.id,teamId);
      const added=await call('team_leader',{operation:'add_team_tasks',arguments:{teamId,revision:current.nativeProjection.team.revision,tasks:[{id:'native-ui-proof-task',title:'Actual engine task projection',goal:'Verify native retained team header',acceptance:'Actual engine task is rendered in retained native session',memberId:'proof-member',priority:3,dependencies:[]}]},responseView:'summary'});
      const result=await call('open_team_workspace',{});assert.ok(result.nativeProjection.team.tasks.some(task=>task.id==='native-ui-proof-task'));
      await save({status:'PASS',sessionId:agent.id,teamId,agentIdentityVerified:true,projection:result.nativeProjection,addReceiptKind:added.kind});
      console.log(`NATIVE_ENGINE_PASS session=${agent.id}; team=${teamId}; actual engine task; model turns=${events.length}`);
    }catch(error){await save({status:'BLOCKED',sessionId:agent.id,message:error.message});console.error(`NATIVE_ENGINE_BLOCKED ${error.message}`);}
  });
  ownedAgent=await ctx.agents.create({sessionId:randomUUID(),meta:{cwd:resolve('.')}});
  await writeFile(join(evidence,'boot.json'),JSON.stringify({kind:'installed-native-web',runtimeRoot,packageRoot,version:metadata.version,clientExport:metadata.exports['./client'],modelTurns:0,pid:process.pid,isolatedHome:process.env.DSH_HOME,engineRoot:process.env.TEAM_WORKSPACE_DATA_ROOT,workspaceId:workspace.id,workspacePath:resolve('.'),sessionId:ownedAgent.agent.id,loaded:true},null,2));
  console.log(`NATIVE_UI_READY installed DSH web; pid=${process.pid}; use native New Session; model turns=0; temporary profile only`);
  // Keep the actual native web host available for browser inspection. Enter to stop.
  process.stdin.resume();await new Promise(resolve=>process.stdin.once('data',resolve));
}catch(error){console.error(`NATIVE_UI_BLOCKED ${error.name}: ${error.message}`);process.exitCode=1;}
finally{await ownedAgent?.dispose();await runtime?.shutdown.shutdown(process.exitCode??0);}
