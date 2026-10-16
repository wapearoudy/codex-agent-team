// Transport an authenticated binding reply into the same persistent store used
// by submission. This does not execute work, run validation or create an agent.
import {cachedStepProjection} from './cached-step.mjs';
export async function runLeaderStart({tools,ALL_TOOLS,text,store,load,project=cachedStepProjection},args){
 const name=ALL_TOOLS.find(t=>t.name.endsWith('__team_leader'))?.name;
 if(!name)return text({kind:'leader-start-blocked',reason:'Leader tool unavailable; retain the exact reservation.',startsModel:false,runsCommands:false});
 const result=await tools[name]({operation:'start_leader_team_task',arguments:args});
 if(result.isError)return text(result);
 const execution=result.structuredContent??JSON.parse(result.content.find(c=>c.type==='text').text);
 if(execution.kind!=='leader-execution'||execution.readyForWork!==true||execution.teamId!==args.teamId||execution.taskId!==args.taskId||execution.attemptId!==args.attemptId)throw Error('Binding reply does not authorize this exact Leader attempt; preserve the reservation and evidence.');
 const payload={leaderExecution:execution};
  if(payload.leaderExecution?.readyForWork&&payload.leaderExecution.turnId){
   const ex=payload.leaderExecution,k='leaderSubmission:'+ex.attemptId,epoch='leaderSubmissionEpoch:'+ex.attemptId;
   if(ex.resumedFromTurnId&&load(epoch)!==ex.turnId){const old=load(k);if(old!=null)store('leaderSubmissionHistory:'+ex.attemptId,[...(load('leaderSubmissionHistory:'+ex.attemptId)??[]),{turnId:load(epoch)??ex.resumedFromTurnId,state:old}]);store(k,null);store('teamDelivery',null);}
   store(epoch,ex.turnId);
  }
 store('teamStep',{kind:'leader-started',teamId:args.teamId,taskId:args.taskId,attemptId:args.attemptId,leaderExecution:execution});
 if(JSON.stringify(load('teamDeliveryIdentity'))!==JSON.stringify(execution.reportArguments))store('teamDelivery',null);
 store('teamDeliveryIdentity',execution.reportArguments);
 text(project(execution,{load,store}));
}
export function leaderStartTransport(args){
 return {operation:'start_leader_team_task',arguments:args,
  program:`await (${runLeaderStart.toString()})({tools,ALL_TOOLS,text,store,load,project:${cachedStepProjection.toString()}},${JSON.stringify(args)});`,
  invocation:"await (new Function('tools','ALL_TOOLS','text','store','load','return (async()=>{'+load('teamStep').leaderExecution.nextRead.program+'})()'))(tools,ALL_TOOLS,text,store,load);"};
}
