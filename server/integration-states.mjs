// The states an integration reports (server/integrations.mjs, docs/plugins.md → Integrations), and the worst of a
// few of them. No imports: the plugin API re-exports worstState (server/plugin-api.mjs).
export const INTEGRATION_STATES=Object.freeze(['ok','stale','error','off','not-configured','disabled']);
// The worst of a few item states, for a status made of parts (several hosts, several bridges).
// No parts, or only parts that are not configured: "not-configured". Everything fine: "ok". Some
// broken and some fine: "stale" (it works, partly). Nothing fine: "error".
export function worstState(states){
 const live=states.filter(s=>s!=='not-configured'&&s!=='off');
 if(!live.length)return states.includes('off')?'off':'not-configured';
 if(live.every(s=>s==='ok'))return 'ok';
 if(live.some(s=>s==='ok'||s==='stale'))return 'stale';
 return 'error';
}
