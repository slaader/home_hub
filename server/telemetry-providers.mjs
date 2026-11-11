// The agent-less telemetry providers in one table: the name people see, the system each reads, the family
// whose readings it shares (one history directory and one meaning per family), the integration that turns it
// off, and the sentence for each of its failure codes. Thermo (server/thermo-client.mjs) is the agent and is not here.
import {WINDOWS_PROVIDER,WINDOWS_ADAPTER_NAME,WINDOWS_ERRORS} from './windows-telemetry.mjs';
import {WINRM_PROVIDER,WINRM_NAME,WINRM_ERRORS} from './winrm-telemetry.mjs';
import {PROMETHEUS_PROVIDER,PROMETHEUS_NAME,PROMETHEUS_ERRORS} from './prometheus-telemetry.mjs';
import {NODE_EXPORTER_PROVIDER,NODE_EXPORTER_NAME,NODE_EXPORTER_ERRORS,LINUX_SSH_PROVIDER,LINUX_SSH_NAME,LINUX_SSH_ERRORS} from './linux-telemetry.mjs';

export const FEEDS=Object.freeze({
 [WINDOWS_PROVIDER]:Object.freeze({id:WINDOWS_PROVIDER,name:WINDOWS_ADAPTER_NAME,platform:'windows',family:'windows',integration:'home.windows',errors:WINDOWS_ERRORS}),
 [WINRM_PROVIDER]:Object.freeze({id:WINRM_PROVIDER,name:WINRM_NAME,platform:'windows',family:'windows',integration:'home.winrm',errors:WINRM_ERRORS}),
 [NODE_EXPORTER_PROVIDER]:Object.freeze({id:NODE_EXPORTER_PROVIDER,name:NODE_EXPORTER_NAME,platform:'linux',family:'linux',integration:'home.node-exporter',errors:NODE_EXPORTER_ERRORS}),
 [PROMETHEUS_PROVIDER]:Object.freeze({id:PROMETHEUS_PROVIDER,name:PROMETHEUS_NAME,platform:'linux',family:'linux',integration:'home.prometheus',errors:PROMETHEUS_ERRORS}),
 [LINUX_SSH_PROVIDER]:Object.freeze({id:LINUX_SSH_PROVIDER,name:LINUX_SSH_NAME,platform:'linux',family:'linux',integration:'home.linux-ssh',errors:LINUX_SSH_ERRORS})});
export const isFeed=p=>typeof p==='string'&&Object.hasOwn(FEEDS,p);
export const feedErrors=p=>isFeed(p)?FEEDS[p].errors:{};
// The provider reading an added device, or null (none, or Thermo: a thermoId always wins).
export const feedOfDevice=d=>d&&!d.thermoId&&isFeed(d.telemetryProvider)?d.telemetryProvider:null;
