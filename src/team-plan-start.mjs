import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DurableStore} from './durable-store.mjs';

const key=(owner,teamId)=>createHash('sha256').update(JSON.stringify([owner,teamId])).digest('hex');
const authorize=(owner,team)=>{if(team.ownerId!==owner)throw new Error('Team start belongs to another conversation');};
const receipt=row=>({requestId:row.requestId,status:row.status,planVersion:row.planVersion,planHash:row.planHash});

// A human's initial approval may hand a start instruction to the same chat.
// This outbox never sends a message or launches a model. Unknown sends are not
// retried; the ordinary Leader workflow remains the only dispatch authority.
export class TeamPlanStart {
  constructor(root){this.store=new DurableStore(join(root,'plan-start-requests.json'),{teams:{}});}
  async read(owner,team){authorize(owner,team);const rows=(await this.store.read()).teams[key(owner,team.id)]??[];const row=rows.findLast(r=>r.planHash===team.planReview?.hash&&r.planVersion===team.planReview?.version);return row?receipt(row):null;}
  async request(owner,team,{planVersion,planHash,requestId,retryOf}){
    authorize(owner,team);
    const p=team.planReview;
    if(p?.scope!=='initial'||p.status!=='approved'||p.version!==planVersion||p.hash!==planHash||p.approval?.source!=='panel-user-action'||p.approval.version!==planVersion||p.approval.hash!==planHash)throw new Error('A current initial plan approved by the user in this panel is required');
    if(team.state!=='active'||team.dispatchPaused||team.executionControl&&team.executionControl.status!=='active')throw new Error('Team is stopped or no longer active; preserve the approval and do not start it');
    if(team.tasks.some(t=>t.attempts.length))return {kind:'team-plan-start',firstOffer:false,status:'already-started'};
    return this.store.transaction(d=>{
      const rows=d.teams[key(owner,team.id)]??=[];
      const existing=rows.find(r=>r.requestId===requestId);
      if(existing){if(existing.planHash!==planHash||existing.planVersion!==planVersion||existing.retryOf!==retryOf)throw new Error('Start request ID already has different contents');return {kind:'team-plan-start',firstOffer:false,...receipt(existing)};}
      const previous=rows.findLast(r=>r.planHash===planHash&&r.planVersion===planVersion);
      if(previous&&!(previous.status==='failed'&&retryOf===previous.requestId))return {kind:'team-plan-start',firstOffer:false,...receipt(previous)};
      if(retryOf&&!previous)throw new Error('No failed start request exists to retry');
      const row={requestId,planVersion,planHash,...(retryOf?{retryOf}:{}),status:'reserved',createdAt:new Date().toISOString()};rows.push(row);
      return {kind:'team-plan-start',firstOffer:true,...receipt(row),message:{role:'user',content:[{type:'text',text:`我已在团队面板确认第 ${planVersion} 版初始团队和目标，请开始执行这个已确认团队。teamId=${team.id}，planHash=${planHash}，startRequestId=${requestId}。先核对当前项目团队、批准版本和控制状态；如已停止、版本变化或已开始，不重复启动。范围有效时直接在已确认职责和写入范围内拆分任务与独立审查，派发就绪任务并保持原生协作，不再要求我回复“启动”。`}]}};
    });
  }
  async record(owner,team,{requestId,status,note=''}){
    authorize(owner,team);
    if(!['host-accepted','failed','unknown'].includes(status))throw new Error('Invalid panel start delivery status');
    return this.store.transaction(d=>{
      const row=d.teams[key(owner,team.id)]?.find(r=>r.requestId===requestId);if(!row)throw new Error('Start request not found for this conversation');
      if(row.status!=='reserved'&&row.status!==status)throw new Error('Start delivery was already recorded; do not replace an uncertain or successful receipt');
      if(row.status==='reserved'){row.status=status;row.note=String(note).slice(0,500);row.updatedAt=new Date().toISOString();}
      return {kind:'team-plan-start-receipt',...receipt(row)};
    });
  }
}
