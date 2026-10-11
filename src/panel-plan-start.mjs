// Called only by the user's initial-plan approve/start button. Never call this
// from polling, rendering, member progress or a background coordination loop.
export async function sendPanelPlanStart(app,call,args,{isCurrent=()=>true}={}){
  if(!app.getHostCapabilities?.()?.message||typeof app.sendMessage!=='function')return {status:'unsupported'};
  const offered=await call('request_team_plan_start',args);
  if(!offered.firstOffer)return offered;
  let status='unknown',note='Host message response was not confirmed';
  try{
    if(!isCurrent()){status='failed';note='User left or changed the selected plan before sending';}
    else {const sent=await app.sendMessage(offered.message);if(sent){status=sent.isError?'failed':'host-accepted';note=sent.isError?'Host explicitly rejected the start instruction':'Host accepted the user start instruction; execution remains unconfirmed';}}
  }catch(error){note=String(error?.message??error);}
  try{await call('record_team_plan_start',{teamId:args.teamId,requestId:offered.requestId,status,note:note.slice(0,500)});}
  catch(error){return {...offered,firstOffer:false,status,receiptSaved:false,note:String(error?.message??error)};}
  return {...offered,firstOffer:false,status,receiptSaved:true};
}
