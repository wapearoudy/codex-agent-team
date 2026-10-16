import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {DurableStore} from './durable-store.mjs';
import {compileTeamTasks} from './team-plan-compiler.mjs';
import {validatePlan} from './team.mjs';
import {assertStartupConfiguration} from './team-startup.mjs';

// Only an already authorized fresh goal uses this entry. Confirmation-only
// formation and existing-team changes retain their original approval flow.
export async function startTeamGoal(projects,owner,context,input){
  assertStartupConfiguration({...input,startupProtocol:input.startupProtocol??'task-bound',memberStartup:input.memberStartup??'on-demand'});
  if(input.startupProtocol&&input.startupProtocol!=='task-bound'||input.memberStartup&&input.memberStartup!=='on-demand')throw Error('start_team_goal only supports task-bound/on-demand startup; use explicit legacy formation for roster initialization');
  if(input.approvalMode!=='immediate'||!input.executionAuthorization?.trim())throw new Error('start_team_goal requires explicit user execution authorization; use plan_team for confirmation.');
  if(input.units?.some(u=>u.executionMode==='leader')&&(context.hostId??'codex')!=='codex')throw new Error('Leader execution checkpoints are currently supported only by the native Codex host');
  const {members,goal,requestId,maxParallel=3,policy,...compilation}=input;
  if(!/^[0-9a-f-]{36}$/i.test(requestId??''))throw new Error('Stable goal request UUID required');
  const plan={members:structuredClone(members),tasks:[]};validatePlan(plan,{allowEmpty:true});
  const digest=createHash('sha256').update(JSON.stringify({cwd:context.cwd,input})).digest('hex');
  const requests=new DurableStore(join(projects.leader.root,'goal-starts.json'),{requests:{}});
  const requestKey=createHash('sha256').update(owner+':'+requestId).digest('hex');
  return requests.transaction(async saved=>{
    const prior=saved.requests[requestKey];
    if(prior&&prior.hash!==digest)throw new Error('Goal request ID already has different contents');
    const existing=await projects.current(owner,context);
    if(prior&&existing?.id!==prior.teamId)throw new Error('Saved goal is historical; do not apply it to a replacement project team.');
    if(existing&&!prior){
      // Recover a lost formation response only for this exact deterministic
      // plan request, never attach new authorization to another project team.
      if(existing.goalStartRequest?.requestId!==requestId||existing.goalStartRequest.hash!==digest)return {kind:'goal-start-blocked',code:'existing-project-team',teamId:existing.id,revision:existing.revision,startsModel:false,instruction:'Reuse the existing confirmed team with compile_team_tasks; do not replace members or retry fresh formation.'};
    }
    const preflight=compileTeamTasks(existing??{hostId:context.hostId??'codex',members:plan.members,tasks:[],batches:[]},compilation,{leaderRoute:context.modelRoute});
    // A committed replay has existing IDs; compileTasks verifies its saved
    // semantic hash before any writes and returns no duplicate dispatch.
    if(!prior&&!existing&&!preflight.valid)return preflight;
    if(!existing&&prior)throw new Error('Saved goal no longer belongs to the current project team; preserve its history.');
    const team=existing??(await projects.plan(owner,context,{goal,plan,maxParallel,...(policy?{policy}:{}),requestId,taskPlanning:'leader',memberStartup:'on-demand',startupProtocol:'task-bound',approvalMode:'immediate',execute:true,executionAuthorization:input.executionAuthorization,goalStartHash:digest})).team;
    saved.requests[requestKey]={hash:digest,teamId:team.id};
    const data=await projects.leader.compileTasks(owner,team.id,team.revision,{...compilation,teamId:team.id,revision:team.revision,requestId,commit:true,dispatchReady:true,dispatchView:'reference'},{leaderRoute:context.modelRoute});
    return {...data,goalStart:{requestId,replayed:!!prior,startsModel:false}};
  });
}
