import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {LeaderEngine} from '../src/leader-engine.mjs';
// Local maintenance only, invoked by a human-authorized repair. Team ownership
// is unchanged. No fabricated host _meta, cross-thread message or model start.
const args=process.argv.slice(2),file=args.find(a=>!a.startsWith('--'));
if(!file||args.some(a=>a.startsWith('--')&&!['--apply','--dry-run'].includes(a))||args.includes('--apply')&&args.includes('--dry-run'))throw new Error('Usage: node scripts/register-native-work.mjs PLAN.json [--dry-run|--apply]');
const input=JSON.parse(await readFile(resolve(file),'utf8'));
if(input.authorization?.source!=='explicit-human-repair-request'||!input.authorization.text?.trim())throw new Error('Save the actual human authorization before repairing local records');
const engine=new LeaderEngine();
try{
 const rpc=await engine.observer.connect(),{thread}=await rpc.call('thread/read',{threadId:input.leaderThreadId,includeTurns:false});
 if(thread.id!==input.leaderThreadId||await realpath(thread.cwd)!==await realpath(input.projectPath))throw new Error('Original Leader/project metadata mismatch');
 const owner=engine.store.ownerId(input.leaderThreadId),team=await engine.store.get(input.teamId,owner);
 if(team.leaderThreadId!==input.leaderThreadId||await realpath(team.projectPath)!==await realpath(input.projectPath))throw new Error('Team ownership/project mismatch');
 const dryRun=!args.includes('--apply');
 if(!dryRun){
  const backup=resolve(dirname(file),'before-native-registration-'+team.revision+'.json');
  await writeFile(backup,JSON.stringify(team,null,2),{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});
 }
 const result=await engine.registerNative(owner,team.id,team.revision,{...input,dryRun});
 const report={at:new Date().toISOString(),dryRun,replayed:result.replayed,registration:result.registration,beforeRevision:team.revision,afterRevision:result.team?.revision??team.revision,ownerUnchanged:!result.team||result.team.ownerId===team.ownerId,leaderUnchanged:!result.team||result.team.leaderThreadId===team.leaderThreadId,modelsStarted:false,messagesSent:false,workRerun:false,tasks:result.team?.tasks.map(t=>({id:t.id,status:t.status,attempts:t.attempts.map(a=>({id:a.id,state:a.state,threadId:a.agentThreadId,turnId:a.turnId,turnIds:a.turnHistory?.map(r=>r.turnId)??[a.turnId],runtimeStatus:a.runtimeStatus,review:a.review??null,deliveryValidationError:a.nativeDeliveryValidationError??null}))}))};
 const output=resolve(dirname(file),dryRun?'native-registration-preview.json':'native-registration-result.json');await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));
 console.log(JSON.stringify({output,dryRun,replayed:report.replayed,beforeRevision:report.beforeRevision,afterRevision:report.afterRevision,tasks:report.tasks?.map(t=>({id:t.id,status:t.status,attemptCount:t.attempts.length,currentRuntime:t.attempts.at(-1)?.runtimeStatus}))}));
}finally{await engine.observer.close();}
