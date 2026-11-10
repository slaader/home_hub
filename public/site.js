// What this hub is and how it shows time. app.js fills it from GET /api/ui/manifest (the site
// configuration on the server); until then, and in a hub without one, everything is neutral.
let current={name:'',timeZone:null,defaultLanguage:'en',lanCidrs:[],inventory:{places:[],secretStores:[]},apiDocs:[]};
export const site=()=>current;
export function setSite(next){current={...current,...next,inventory:{...current.inventory,...next?.inventory}};}
// For Intl formatters: the zone the site configured, else undefined = the browser's own zone.
export const timeZone=()=>current.timeZone||undefined;
export const zoneName=()=>current.timeZone||(()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone;}catch{return 'UTC';}})();
