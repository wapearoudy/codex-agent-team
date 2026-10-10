import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
// Page exact saved public evidence. Truncation is explicit and reversible; the
// persisted observation and validation gates always retain the original bytes.
export function evidencePage(team,{taskId,attemptId,section='delivery',commandIndex,offset=0,limit=4000,cursor}={}){
  if(!['delivery','commands','command','command-output','checkpoint','verification','review-registration'].includes(section)||!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<512||limit>8000)throw new Error('Invalid evidence page');
  if(offset>0&&!cursor)throw new Error('A saved evidence cursor is required for subsequent pages');
  const task=team.tasks.find(t=>t.id===taskId),a=attemptId?task?.attempts.find(a=>a.id===attemptId):task?.attempts.at(-1);
  if(!a)throw new Error('Task evidence attempt not found');
  const commands=a.observation?.commands??[];
  if(['command','command-output'].includes(section)&&(!Number.isInteger(commandIndex)||commandIndex<0||!commands[commandIndex]))throw new Error('Evidence command index not found');
  const checkpoint=section==='checkpoint'?team.checkpoints?.find(c=>c.id===a.phaseHandoff?.checkpointId):null;if(section==='checkpoint'&&!checkpoint)throw new Error('Phase checkpoint not found');
  const body=section==='review-registration'?JSON.stringify({futureCheckAssociations:a.futureCheckAssociations,reviewReconciliations:a.reviewReconciliations,acceptanceException:a.acceptanceException,acceptanceExceptionHistory:a.acceptanceExceptionHistory,settlementException:a.settlementException,settlementExceptionHistory:a.settlementExceptionHistory}):section==='verification'?JSON.stringify(a.verificationReconciliations??[]):section==='checkpoint'?JSON.stringify(checkpoint):section==='commands'?'':section==='command'?commands[commandIndex].command??'':section==='command-output'?commands[commandIndex].output??'':a.observation?.outputs?.at(-1)?.text??task.evidence?.find(e=>e.attemptId===a.id)?.summary??'';
  let bodyHash;
  if(section==='commands'){
    const digest=createHash('sha256').update(String(commands.length));
    for(const c of commands)digest.update(JSON.stringify([c.commandId,c.turnId,c.cwd,c.command,c.status,c.exitCode,hash(String(c.output??''))]));
    bodyHash=digest.digest('hex');
  }else bodyHash=hash(body);
  const token=hash(JSON.stringify([team.id,task.id,a.id,a.turnId,task.contractRevision??1,section,commandIndex??null,bodyHash]));
  if(cursor&&cursor!==token)throw new Error('Evidence changed; do not combine pages from different native results');
  const metadata={kind:'team-evidence',teamId:team.id,revision:team.revision,taskId:task.id,attemptId:a.id,turnId:a.turnId,taskStatus:task.status,attemptState:a.state,nativeStatus:a.observation?.status,requiresNativeSettlement:task.status==='running',section,cursor:token,source:'saved-public-native-evidence',historical:task.attempts.at(-1).id!==a.id,contractRevision:task.contractRevision??1,offset};
  if(section==='commands'){
    if(offset>commands.length)throw new Error('Evidence offset is out of range');
    const rows=[];let bytes=0;
    for(let i=offset;i<commands.length&&rows.length<30;i++){
      const c=commands[i],command=String(c.command??''),row={index:i,...(c.commandId?{commandId:c.commandId}:{}),...(c.cwd?{cwd:c.cwd}:{}),turnId:c.turnId??a.turnId,command:command.slice(0,300),commandTruncated:command.length>300,status:c.status,exitCode:c.exitCode,outputChars:String(c.output??'').length,fullTextAccess:{tool:'read_team_context',view:'evidence',taskId:task.id,attemptId:a.id,commandIndex:i,sections:['command','command-output']}};
      const size=Buffer.byteLength(JSON.stringify(row));if(rows.length&&bytes+size>limit)break;rows.push(row);bytes+=size;
    }
    return {...metadata,commands:rows,nextOffset:offset+rows.length,hasMore:offset+rows.length<commands.length,totalCommands:commands.length,outputLimitChars:limit};
  }
  if(offset>body.length)throw new Error('Evidence offset is out of range');
  const text=body.slice(offset,offset+limit),nextOffset=offset+text.length;
  return {...metadata,...(commandIndex!==undefined?{commandIndex}:{}),text,nextOffset,hasMore:nextOffset<body.length,totalChars:body.length,outputLimitChars:limit};
}
