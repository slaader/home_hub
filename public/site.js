// What this hub is and how it shows time. app.js fills it from GET /api/ui/manifest (the site
// configuration on the server, plus what the loaded modules documented: API rows, MCP tools, their own
// names); until then, and in a hub without one, everything is neutral.
let current={name:'',timeZone:null,defaultLanguage:'en',lanCidrs:[],inventory:{places:[],secretStores:[]},apiDocs:[],tools:[],modules:[]};
export const site=()=>current;
export function setSite(next){current={...current,...next,inventory:{...current.inventory,...next?.inventory}};}
// For Intl formatters: the zone the site configured, else undefined = the browser's own zone.
export const timeZone=()=>current.timeZone||undefined;
export const zoneName=()=>current.timeZone||(()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone;}catch{return 'UTC';}})();
// The optional telemetry agent that feeds live CPU, GPU, power, temperature and memory to the overview.
// The address is a placeholder until the agent has a public home; change it here and every page, empty
// state and the getting-started checklist follows.
export const TELEMETRY_AGENT_NAME='Thermo';
export const TELEMETRY_AGENT_URL='https://example.com/home-hub/telemetry-agent';
