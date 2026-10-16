// Cache the authenticated binding receipt. Models fill factual fields and
// never retype a reserved capability after a long implementation.
export function memberBootstrapProgram(args){
 return `await (async()=>{const n=ALL_TOOLS.find(t=>t.name.endsWith('__team_member'))?.name; if(!n)throw new Error('Member tool unavailable; preserve this attempt'); const r=await tools[n]({operation:"start_member_team_task",arguments:${JSON.stringify({...args,includeTaskContext:true})}}); if(r.isError){text(r);exit();} const payload=r.structuredContent??JSON.parse(r.content.find(c=>c.type==='text').text); if(payload.readyForWork===true)store('teamMemberBootstrap',payload); const {reportProgram,reportArguments,nextReportRequestId,...view}=payload; text(view);})();`;
}
export async function runCachedMemberReport({tools,ALL_TOOLS,text,store,load}){
 const b=load('teamMemberBootstrap'),report=load('teamMemberDelivery');
 if(!b?.readyForWork||!b.reportArguments?.bootstrapToken||!b.nextReportRequestId||!report||typeof report!=='object'||Array.isArray(report))throw Error('Retain authenticated bootstrap and store factual teamMemberDelivery before reporting');
 const delivery=JSON.stringify(report),finished=load('teamMemberFinishedReport');
 if(typeof report.summary!=='string'||!report.summary.trim()||report.summary.length>3000||delivery.length>24000||report.verificationInputs!==undefined&&(!Array.isArray(report.verificationInputs)||report.verificationInputs.length>30||report.verificationInputs.some(p=>typeof p!=='string'||!p||p.length>300)))throw Error('Correct report summary, size or verificationInputs before submitting; retain tests and current attempt');
 if(finished){if(finished.delivery!==delivery)throw Error('A valid final report is already saved; end this turn, never replace it');text(finished.receipt);return;}
 const name=ALL_TOOLS.find(t=>t.name.endsWith('__team_member'))?.name;if(!name)throw Error('Member tool unavailable; retain delivery and pending request');
 let pending=load('teamMemberPendingReport');
 if(pending&&pending.delivery!==delivery)throw Error('Previous report outcome is unknown; retain its exact request before editing or retrying');
 pending??={...b.reportArguments,requestId:b.nextReportRequestId,summary:report.summary,delivery,...(report.verificationInputs?{verificationInputs:report.verificationInputs}:{})};
 store('teamMemberPendingReport',pending);
 const result=await tools[name]({operation:'report_member_team_task',arguments:pending});
 if(result.isError){const recoveryReceipt={kind:'team-report-recovery',requestId:pending.requestId};store('teamMemberRecoveryReceipt',recoveryReceipt);text({kind:'member-report-error',error:result.structuredContent??result.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n'),recoveryReceipt,instruction:'Preserve this exact proposal and all native results. For a terminal registration blocker emit JSON.stringify(load("teamMemberRecoveryReceipt")) and END; plugin will only recover this original native proposal with unchanged complete evidence. Never rerun tests, replace the task or invent a verdict.'});return;}
 const receipt=result.structuredContent??JSON.parse(result.content.find(c=>c.type==='text').text);store('teamMemberReportReceipt',receipt);
 if(receipt.deliveryPreflight?.valid===false){if(!receipt.nextReportRequestId)throw Error('Report correction lacks a fresh request; retain original draft');b.nextReportRequestId=receipt.nextReportRequestId;store('teamMemberBootstrap',b);store('teamMemberPendingReport',null);}
 if(receipt.deliveryPreflight?.valid===true){store('teamMemberFinishedReport',{delivery,receipt});store('teamMemberPendingReport',null);}
 text(receipt);
}
export const memberReportProgram=()=>`await (${runCachedMemberReport.toString()})({tools,ALL_TOOLS,text,store,load});`;
export const memberReportInvocation="await new (Object.getPrototypeOf(async function(){}).constructor)('tools','ALL_TOOLS','text','store','load',load('teamMemberBootstrap').reportProgram)(tools,ALL_TOOLS,text,store,load);";
