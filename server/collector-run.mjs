// How a collector was started, recorded in the snapshot it writes (field `run`), so a page can say
// "scheduled by launchd" or "run by hand" instead of guessing from the snapshot's age.
//   {trigger: "scheduled", scheduler: "launchd" | "systemd", label?}   a scheduled job started it
//   {trigger: "manual"}                                               someone ran it in a terminal
//   null                                                              not knowable (cron, a pipe, another tool)
// launchd puts the job's label into XPC_SERVICE_NAME ("0" or "application.…" for anything started from a
// terminal or an app); systemd gives every service an INVOCATION_ID (the unit's name
// arrives in HOME_HUB_UNIT when the unit sets it: Environment=HOME_HUB_UNIT=%n). A terminal means a person.
const LABEL=/^[A-Za-z0-9][A-Za-z0-9._@:-]{0,119}$/;
export function collectorRun({env=process.env,tty=Boolean(process.stdin?.isTTY||process.stdout?.isTTY)}={}){
 const xpc=typeof env.XPC_SERVICE_NAME==='string'?env.XPC_SERVICE_NAME:'';
 if(!tty&&xpc&&xpc!=='0'&&!xpc.startsWith('application.')&&LABEL.test(xpc))return {trigger:'scheduled',scheduler:'launchd',label:xpc};
 if(!tty&&env.INVOCATION_ID){const unit=typeof env.HOME_HUB_UNIT==='string'&&LABEL.test(env.HOME_HUB_UNIT)?env.HOME_HUB_UNIT:null;return {trigger:'scheduled',scheduler:'systemd',...(unit?{label:unit}:{})};}
 return tty?{trigger:'manual'}:null;
}
// What a snapshot holds → the same shape, or null for a snapshot written before the stamp existed.
export function readRun(run){
 if(!run||typeof run!=='object'||!['scheduled','manual'].includes(run.trigger))return null;
 const scheduler=['launchd','systemd'].includes(run.scheduler)?run.scheduler:null,label=typeof run.label==='string'&&LABEL.test(run.label)?run.label:null;
 return {trigger:run.trigger,...(run.trigger==='scheduled'&&scheduler?{scheduler}:{}),...(run.trigger==='scheduled'&&label?{label}:{})};
}
