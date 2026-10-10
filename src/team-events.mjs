import {watch} from 'node:fs';
import {basename} from 'node:path';
import {coordinationSignature} from './team-efficiency.mjs';

// Wait inside the existing Leader tool call, never inject a chat item or start
// a model. Watch the directory because atomic saves replace the document inode.
export function waitTeamEvent(store,owner,teamId,{revision,timeoutMs=45000,signal,observe,subscribe}={}) {
  if(!Number.isInteger(revision)||revision<1||!Number.isInteger(timeoutMs)||timeoutMs<0||timeoutMs>55000)throw new Error('A saved revision and a timeout between 0 and 55000 ms are required');
  const names=new Set([basename(store.path(teamId)),teamId+'.v2.json']);
  return new Promise((resolve,reject)=>{
    let finished=false,reading=false,pending=false,expired=false,nativeDirty=!!observe,lastNativeAt=0,watcher,timer,fallback,nativeTimer,unsubscribe,signature,currentRevision=revision;
    const finish=(error,value)=>{
      if(finished)return;finished=true;watcher?.close();clearTimeout(timer);clearInterval(fallback);clearTimeout(nativeTimer);unsubscribe?.();signal?.removeEventListener('abort',abort);
      if(error)reject(error);else resolve({kind:'team-event',teamId,...value,chatMessages:false,nextTool:value.status==='timeout'?'wait_team_event':value.status==='cancelled'?null:'read_team',...(value.status==='timeout'?{unchanged:true,readRequired:false}:{} )});
    };
    const abort=()=>finish(null,{status:'cancelled',revision:currentRevision});
    const check=async(timedOut=false)=>{
      if(finished)return;expired ||= timedOut;
      if(reading){pending=true;return;}
      reading=true;
      try {
        // The compact document is enough; do not hydrate historical evidence or
        // read native threads just to notice a panel control request.
        const saved=await store.document(teamId).read();
        if(saved.ownerId!==owner)throw new Error('Team not found in this Desktop conversation');
        if(saved.revision<currentRevision)throw new Error('Team revision moved backwards; refresh before waiting');
        const nextSignature=coordinationSignature(saved);
        if(signature===undefined&&saved.revision!==revision||signature!==undefined&&signature!==nextSignature)finish(null,{status:'changed',revision:saved.revision});
        else if(['archived','superseded','cancelled','delivered'].includes(saved.state))finish(null,{status:'terminal',revision:saved.revision});
        else {
          signature=nextSignature;currentRevision=saved.revision;
          if(nativeDirty&&observe){
            const delay=1000-(Date.now()-lastNativeAt);
            if(delay>0&&!expired){clearTimeout(nativeTimer);nativeTimer=setTimeout(()=>void check(),delay);}
            else {nativeDirty=false;lastNativeAt=Date.now();const snapshot=await observe();const attempts=(snapshot.workflow?.actions??[]).filter(a=>a.type==='settle').map(a=>({taskId:a.taskId,attemptId:a.attemptId,status:a.observedStatus}));
              if(snapshot.team.revision!==currentRevision){pending=true;}
              else if(attempts.length)finish(null,{status:'member-terminal',revision:currentRevision,attempts,automaticAcceptance:false});
            }
          }
          if(!finished&&(expired||timeoutMs===0))finish(null,{status:'timeout',revision:saved.revision});
        }
      }catch(error){finish(error);}finally{reading=false;if(pending&&!finished){pending=false;void check();}}
    };
    // Establish the watcher before reading to avoid a save between the snapshot
    // and subscription. A slow fallback covers platforms that lose FS events.
    try{watcher=watch(store.root,(_,file)=>{if(!file||names.has(String(file)))void check();});watcher.on('error',error=>finish(error));}catch(error){finish(error);return;}
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    timer=setTimeout(()=>void check(true),timeoutMs);
    fallback=setInterval(()=>void check(),2000);
    void (async()=>{try{if(subscribe){const stop=await subscribe(()=>{nativeDirty=true;void check();});if(finished){stop();return;}unsubscribe=stop;}void check();}catch(error){finish(error);}})();
  });
}
