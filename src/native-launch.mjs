import {nativeRoute} from './team-policy.mjs';
import {literalShellWords} from './verification-command.mjs';

export function isBootstrapPrelude(item){
 if(item.type!=='commandExecution'||!['completed','failed'].includes(item.status)||!Number.isInteger(item.exitCode))return false;
 return bootstrapReadSyntax(item.command);
}
// In-flight reads are waitable, never completed proof for binding or recovery.
export function isPendingBootstrapPrelude(item){
 return item.type==='commandExecution'&&item.status==='inProgress'&&item.exitCode==null&&bootstrapReadSyntax(item.command);
}
function bootstrapReadSyntax(command){
 if(typeof command!=='string')return false;
 for(let depth=0;depth<4;depth++){const words=literalShellWords(command);if(!words||words.length!==3||!['/bin/zsh','/bin/bash','/bin/sh','zsh','bash','sh'].includes(words[0])||!['-c','-lc','-cl'].includes(words[1]))break;command=words[2];}
 // Required AGENTS/skill reads are harmless even when the requested file is
 // absent. No shell expansion, arbitrary executable, workspace redirection,
 // pipe or sed write/execute program can qualify as a read-only prelude.
 return command.replace(/>\s*\/dev\/null(?=\s*(?:&&|;|$))/g,'').split(/\s*(?:&&|;|\n)\s*/).every(script=>{
  if(/^(?:\/bin\/)?pwd(?: -[LP])?$/.test(script))return true;
  if(/^(?:\/bin\/)?(?:cat|head|tail) [\p{L}\p{N}_./ '"-]+$/u.test(script))return true;
  return /^sed -n '[0-9,$]+p' [\p{L}\p{N}_./ '"-]+$/u.test(script);
 });
}
export function hasStartupDelivery(turns){
 return turns.some(t=>(t.items??[]).some(i=>{
  if(i.type!=='agentMessage'||typeof i.text!=='string')return false;
  const body=i.text.trim().replace(/^TEAM_WORKSPACE_ATTEMPT:[^\n]*\n/,'').replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i,'$1');
  try{const value=JSON.parse(body);return value&&typeof value==='object'&&(['decision','checks','acceptanceResults','changedPaths','commandsRun','targets','deliveryHash'].some(k=>Object.hasOwn(value,k))||['team-saved-delivery','team-delivery-receipt','phase-handoff'].includes(value.kind));}catch{return false;}
 }));
}
export function isBootstrapTool(item){
 if(item.type!=='mcpToolCall'||item.server!=='team-workspace-probe')return false;
 return item.tool==='start_member_team_task'||item.tool==='team_member'&&item.arguments?.operation==='start_member_team_task';
}
export function failedBootstrapCall(item){
 return isBootstrapTool(item)&&(item.status==='failed'||item.result?.isError===true)&&item.result?.structuredContent?.readyForWork!==true;
}

// The official schema catalog cannot execute work or grant task authority.
// Keep this exact allowlist separate from arbitrary successful/unknown tools.
export function isBootstrapDiscovery(item){
 return item.type==='mcpToolCall'&&item.server==='team-workspace-probe'&&item.tool==='team_member'&&['describe','directory'].includes(item.arguments?.operation)&&['completed','failed'].includes(item.status)&&item.result?.structuredContent?.readyForWork!==true;
}
export function isPendingBootstrapDiscovery(item){
 return item.type==='mcpToolCall'&&item.server==='team-workspace-probe'&&item.tool==='team_member'&&['describe','directory'].includes(item.arguments?.operation)&&item.status==='inProgress'&&item.result?.structuredContent?.readyForWork!==true;
}

// This is host evidence, never a caller's claim that fork_turns was supplied.
// Native tool defaults cannot be changed by an MCP server. Reject inherited or
// unverifiable launches before handing out a task context or execution authority.
export function assertNativeLaunch(team,member,run){
 const proof=run.launchIdentity;
 if(proof?.source!=='authenticated-native-session-header'||proof.identityVerified!==true||proof.parentThreadId!==team.leaderThreadId||proof.inheritedParentContext!==false||proof.forkedFromId||proof.ownBoundaryVerified!==true)throw Object.assign(Error('native-launch-isolation: expected a verified clean child (fork_turns=none); no writes/tests are authorized'),{code:'NATIVE_LAUNCH_REJECTED'});
 const route=nativeRoute(member),expected={model:route.model??member.routeSnapshot?.model,reasoningEffort:route.reasoning_effort??member.routeSnapshot?.reasoningEffort,provider:member.routeSnapshot?.provider};
 for(const [key,value] of Object.entries(expected))if(value&&run[key]!==value)throw Object.assign(Error(`native-launch-route: ${key} must equal the frozen route ${value}; observed ${run[key]??'unknown'}. No work is authorized`),{code:'NATIVE_LAUNCH_REJECTED'});
}
