// Where a collected snapshot stands, in one of four states every collector-backed screen shows:
//   not-configured  nothing tells the collector which machines to read (no ssh aliases in the site config)
//   waiting         configured, but no snapshot has been written yet
//   stale           the snapshot is older than the collector's interval allows
//   ok              a snapshot of the expected age
// The intervals are the ones the scheduled jobs use (scripts/systems/install-launchd.sh and the
// systemd timers in examples/systemd/), so "stale" means "the job did not run when it should have".
export const COLLECTORS=Object.freeze({
 systems:Object.freeze({script:'scripts/collect-systems.mjs',intervalSeconds:21600}),
 upstream:Object.freeze({script:'scripts/check-upstream.mjs',intervalSeconds:43200}),
 security:Object.freeze({script:'scripts/collect-security.mjs',intervalSeconds:86400}),
 // A router adapter reports every minute; SPEC.md: an observation older than 3 minutes is stale.
 router:Object.freeze({script:'scripts/collect-router-unifi.py',intervalSeconds:60,staleAfterSeconds:180}),
});
// A quarter of the interval is allowed for the run itself and a late timer.
export const staleAfter=c=>c.staleAfterSeconds??Math.round(c.intervalSeconds*1.25);

/** → {state, configured, collectedAt, ageSeconds, intervalSeconds, staleAfterSeconds} */
export function collectorState(name,{configured,collectedAt=null,now=Date.now()}){
 const c=COLLECTORS[name],at=Date.parse(collectedAt),age=Number.isFinite(at)?Math.max(0,Math.round((now-at)/1000)):null;
 const state=age===null?(configured?'waiting':'not-configured'):age>staleAfter(c)?'stale':'ok';
 return {state,configured:Boolean(configured),collectedAt:age===null?null:collectedAt,ageSeconds:age,intervalSeconds:c.intervalSeconds,staleAfterSeconds:staleAfter(c),script:c.script};
}
