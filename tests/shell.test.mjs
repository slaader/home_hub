// The shell and the design system: the tokens (two themes, old names still defined), the shared components
// (ui.js) on the mocked DOM with their old and new signatures, the theme choice, the command palette's
// matching, the rules of the getting-started checklist, the watcher that notices an unreachable hub, and
// what the server serves for all of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {installDom} from './fixtures/mini-dom.mjs';
import {defineModule,createRegistry} from '../server/plugins.mjs';
import {CORE_MODULES} from '../server/index.mjs';
import {hub} from './hub-helper.mjs';
import {SECURITY_SCHEMA} from '../server/security-data.mjs';

const {document,localStorage}=installDom();
const read=file=>readFile(new URL(`../public/${file}`,import.meta.url),'utf8');
const ui=await import('../public/ui.js');
const theme=await import('../public/theme.js');
const {icon,navIcon,ICONS,pageIcon}=await import('../public/icons.js');
const {matchItems,fold}=await import('../public/palette.js');
const {onboardingSteps,offersOnboarding,isDismissed,setDismissed,STEP_IDS}=await import('../public/onboarding.js');
const {PAGES}=await import('../public/session-cache.js');

const all=(node,pick,out=[])=>{if(pick(node))out.push(node);for(const child of node.children||[])all(child,pick,out);return out;};
const byClass=(node,cls)=>all(node,n=>n.classList?.contains(cls));
const byTag=(node,tag)=>all(node,n=>n.tagName===tag);
const declared=(css,block)=>new Map([...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/g)].map(m=>[m[1],m[2].trim()]));

test('tokens: a light palette next to the dark one, the same in both places it is written, nothing renamed',async()=>{
 const css=await read('tokens.css');
 const dark=declared(css,/:root\{([\s\S]*?)\n\}/.exec(css)[1]);
 const system=declared(css,/@media \(prefers-color-scheme:light\)\{\s*:root:not\(\[data-theme="dark"\]\)\{([\s\S]*?)\}\s*\}/.exec(css)[1]);
 const forced=declared(css,/\n:root\[data-theme="light"\]\{([\s\S]*?)\}/.exec(css)[1]);
 assert.deepEqual([...system],[...forced],'the two light blocks must stay identical');
 assert.equal(system.get('color-scheme'),undefined);assert.match(css,/color-scheme:light/);assert.match(css,/color-scheme:dark/);
 const colours=[...dark.keys()].filter(k=>/^--(color|glow|shadow)-/.test(k));
 assert.deepEqual(colours.filter(k=>!system.has(k)),[],'every dark colour, glow and shadow has a light value');
 for(const k of colours)if(k.startsWith('--color-'))assert.notEqual(system.get(k),dark.get(k),`${k} is the same in both themes`);
 // The names pages and plugins were built on before this file grew.
 for(const name of ['--space-1','--space-8','--radius-s','--radius-m','--radius-l','--radius-pill','--font-sans','--font-mono','--text-xs','--text-s','--text-m','--text-l','--text-xl','--text-2xl',
  '--leading-tight','--leading-body','--weight-regular','--weight-medium','--weight-bold','--color-bg','--color-surface','--color-surface-raised','--color-border','--color-border-strong',
  '--color-text','--color-text-dim','--color-text-faint','--color-accent','--color-accent-text','--color-focus','--color-good','--color-warn','--color-bad','--color-info','--shadow-raised'])
  assert.match(css,new RegExp(`${name}:`),`${name} is still defined`);
 for(const name of ['--color-ok','--color-error','--color-muted','--color-good-soft','--color-warn-soft','--color-bad-soft','--color-info-soft','--color-muted-soft','--color-accent-soft','--focus-ring','--shadow-1','--shadow-2','--shadow-3'])
  assert.match(css,new RegExp(`${name}:`),name);
});

test('styles: every custom property the shell uses is defined, and old page styles get their short names from the tokens',async()=>{
 const tokens=await read('tokens.css'),hubCss=await read('hub.css');
 const defined=new Set([...`${tokens}\n${hubCss}`.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m=>m[1]));
 // Set per element by a page (a stack block's own colour), not by a stylesheet.
 const local=new Set(['--sp']);
 const used=[...`${tokens}\n${hubCss}`.matchAll(/var\((--[a-z0-9-]+)/g)].map(m=>m[1]);
 assert.deepEqual([...new Set(used.filter(name=>!defined.has(name)&&!local.has(name)))],[]);
 for(const [short,token] of [['--bg','--color-bg'],['--panel','--color-surface'],['--panel2','--color-surface-sunken'],['--panel3','--color-surface-raised'],['--line','--color-border'],['--line-hi','--color-border-strong'],
  ['--txt','--color-text'],['--dim','--color-text-dim'],['--faint','--color-text-faint'],['--accent','--color-accent'],['--accent2','--color-accent-2'],['--ok','--color-good'],['--warn','--color-warn'],['--crit','--color-bad'],['--mono','--font-mono'],['--sans','--font-sans']])
  assert.ok(hubCss.includes(`${short}:var(${token})`),`${short} → ${token}`);
 // The shell's own rules carry no literal colours: only the tokens (and the brand orb and the category colours).
 const shellRules=hubCss.slice(hubCss.indexOf('*{box-sizing')).split('\n').filter(line=>!/\.hh-orb\{|\.hh-face\{/.test(line)).join('\n');
 assert.deepEqual(shellRules.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g)||[],[],'shell rules use tokens for every colour');
 // The overview and machine pages moved to home.css (.hv-*); their old rules are gone from the shell's file.
 assert.doesNotMatch(hubCss,/\.(home-|dev-|stack-|sp-|hc\b|qc\b|g-dial|mini-stats|tile-spark)/,'no rules of the old device page');
 // Every class the shell's stylesheet styles is one some page or the shell itself uses (w0…w10 are built from a number).
 const sources=(await Promise.all((await readdir(new URL('../public/',import.meta.url))).filter(f=>f.endsWith('.js')||f.endsWith('.html')).map(read))).join('\n');
 const styled=[...new Set([...hubCss.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\{[^{}]*\}/g,'{}').matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m=>m[1]))];
 assert.deepEqual(styled.filter(c=>!/^w\d+$/.test(c)&&!new RegExp(`(?<![\\w-])${c}(?![\\w-])`).test(sources)),[],'no rule for a class nothing uses');
 const index=await read('index.html');
 assert.doesNotMatch(index,/data-theme=/,'no theme is pinned in the page');
 assert.ok(index.indexOf('src="/theme-boot.js"')>0&&index.indexOf('src="/theme-boot.js"')<index.indexOf('rel="stylesheet"'),'the stored theme is applied before the stylesheets load');
 assert.doesNotMatch(index,/<script(?![^>]*\bsrc=)[^>]*>|style="/,'no inline script or style: the page CSP would refuse it');
 assert.match(index,/name="color-scheme" content="dark light"/);
 const boot=await read('theme-boot.js');assert.match(boot,/try\{[^}]*localStorage\.getItem\('hh-theme'\)/,'storage access is guarded');
});

// What breaks in the other theme is a colour that cannot flip: a white tint (invisible on paper), dark text
// written as a literal on the accent (the accent is dark in the light theme), a dialog veil of its own.
test('page styles: what has to flip with the theme is a token, in every core stylesheet',async()=>{
 const files=(await readdir(new URL('../public/',import.meta.url))).filter(f=>f.endsWith('.css')&&f!=='tokens.css');
 assert.ok(files.includes('access.css')&&files.includes('hub.css'));
 for(const file of files){
  const css=await read(file);
  assert.doesNotMatch(css,/rgba?\(\s*255[ ,]+255[ ,]+255/,`${file}: a white tint; use --color-hover or a -soft token`);
  for(const rule of css.match(/[^{}]*\{[^{}]*\}/g)||[]){
   if(/background:[^;}]*var\(--(color-)?accent\b/.test(rule))assert.doesNotMatch(rule,/(?<![-\w])color:\s*#/,`${file}: literal text colour on the accent: ${rule.trim().slice(0,70)}`);
   // Veils behind dialogs follow the theme; a picture viewer (lightbox) stays dark on purpose.
   if(/::backdrop/.test(rule)&&!/lightbox/.test(rule))assert.doesNotMatch(rule,/#[0-9a-fA-F]{3,8}\b|rgba?\(/,`${file}: a veil with a literal colour: ${rule.trim().slice(0,70)}`);
  }
 }
 assert.match(await read('access.css'),/\.acc-btn\.primary\{background:var\(--color-accent\);color:var\(--color-accent-text\)/);
 // The inventory's category colours have a light set next to the dark one, the same in both places it is written.
 const inv=await read('inventory.css'),system=/@media \(prefers-color-scheme:light\)\{:root:not\(\[data-theme="dark"\]\)\{([^}]*)\}\}/.exec(inv),forced=/\n:root\[data-theme="light"\]\{([^}]*)\}/.exec(inv);
 assert.ok(system&&forced);assert.equal(system[1],forced[1]);assert.equal(declared(inv,forced[1]).size,8);
 // Settings offers the same switch as the account menu.
 assert.match(await read('settings-view.js'),/themeSwitch\(\)/);
});

test('theme: system by default, a forced choice is stored, system stores nothing, refused storage is not an error',()=>{
 localStorage.clear();
 assert.equal(theme.getTheme(),'system');assert.ok(['light','dark'].includes(theme.resolvedTheme()));
 let changes=0;globalThis.dispatchEvent=()=>{changes++;};
 theme.setTheme('light');assert.equal(theme.getTheme(),'light');assert.equal(theme.resolvedTheme(),'light');assert.equal(localStorage.getItem('hh-theme'),'light');
 theme.setTheme('dark');assert.equal(localStorage.getItem('hh-theme'),'dark');assert.equal(theme.resolvedTheme(),'dark');
 theme.setTheme('neon');assert.equal(theme.getTheme(),'dark','an unknown theme is ignored');
 theme.setTheme('system');assert.equal(localStorage.getItem('hh-theme'),null);assert.equal(changes,3);
 const real=globalThis.localStorage;globalThis.localStorage={getItem(){throw new Error('denied');},setItem(){throw new Error('denied');},removeItem(){throw new Error('denied');}};
 assert.doesNotThrow(()=>theme.setTheme('light'));assert.equal(theme.getTheme(),'light','the choice still holds for this page');
 globalThis.localStorage=real;theme.setTheme('system');delete globalThis.dispatchEvent;
});

test('ui: the page header, empty state and "not installed" keep their signatures and gain the new parts',()=>{
 // As pages and plugins call them today.
 const head=ui.pageHeader({eyebrow:'Demo',title:'Notes',lead:'Signed in.',actions:[{label:'Docs',href:'https://example.com/docs'},{label:'Add',onclick(){},primary:true}]});
 assert.equal(head.tagName,'header');assert.equal(byTag(head,'h1')[0].textContent,'Notes');
 const [link,button]=byClass(head,'ui-button');
 assert.equal(link.getAttribute('target'),'_blank');assert.equal(link.getAttribute('rel'),'noopener noreferrer');assert.ok(button.classList.contains('primary'));
 assert.equal(byClass(ui.pageHeader({title:'T',back:{label:'Overview',href:'#overview'}}),'ui-back')[0].getAttribute('href'),'#overview');
 assert.equal(ui.pageHeader().tagName,'header','no arguments is fine');

 const plain=ui.emptyState({title:'No notes yet',body:'POST adds one.'});
 assert.equal(plain.getAttribute('role'),'status');assert.equal(byTag(plain,'h2')[0].textContent,'No notes yet');assert.equal(byClass(plain,'ui-empty-icon').length,0);
 const full=ui.emptyState({icon:'◇',title:'Empty',body:'Body',steps:['one','two','three'],agentPrompt:'Do the thing.',mcpSnippet:true,actions:[{label:'Go',href:'#overview',primary:true},null]});
 assert.equal(byClass(full,'ui-empty-icon')[0].textContent,'◇','a glyph is shown as it is');
 assert.deepEqual(byTag(byClass(full,'ui-steps')[0],'li').map(li=>li.textContent),['one','two','three']);
 assert.equal(byTag(full,'pre')[0].textContent,'Do the thing.');
 const tabButtons=all(full,n=>n.getAttribute?.('role')==='tab');
 assert.deepEqual(tabButtons.map(b=>b.textContent),['Claude Code','Codex','JSON'],'the MCP snippet is one tab per client');
 assert.deepEqual(tabButtons.map(b=>b.getAttribute('aria-selected')),['true','false','false']);
 assert.equal(byClass(full,'ui-actions').at(-1).children.length,1,'a missing action is skipped');
 assert.equal(byTag(byClass(ui.emptyState({icon:'box',title:'x'}),'ui-empty-icon')[0],'svg').length,1,'an icon name draws the icon');
 assert.ok(ui.emptyState({title:'x',compact:true}).classList.contains('compact'));
 assert.match(byTag(ui.emptyState({title:'x',mcpSnippet:'my own text'}),'pre')[0].textContent,/my own text/,'a string snippet is one copy block');

 const missing=ui.notInstalled({dependency:'Thermo',installUrl:'https://example.com/thermo',steps:['Install it.']});
 assert.ok(missing.classList.contains('ui-missing'));assert.match(byTag(missing,'h2')[0].textContent,/Thermo/);
 assert.equal(byClass(missing,'ui-button')[0].getAttribute('href'),'https://example.com/thermo');assert.equal(byClass(missing,'ui-pill').length,1,'tagged optional');
 assert.equal(byClass(ui.notInstalled({dependency:'X',optional:false}),'ui-pill').length,0);
 assert.equal(byTag(ui.notInstalled({dependency:'X',agentPrompt:'Install X.'}),'pre')[0].textContent,'Install X.');

 const failed=ui.errorState({title:'Broken',retry(){}});
 assert.equal(failed.getAttribute('role'),'alert');assert.equal(byClass(failed,'ui-button').length,1);
 assert.equal(ui.loadingState('Loading…').getAttribute('role'),'status');assert.equal(ui.skeleton(3).children.length,3);
 assert.ok(ui.statusPill('online','good').classList.contains('good'));
 assert.equal(ui.banner({tone:'bad',title:'Down.'}).getAttribute('role'),'alert');
});

test('ui: MCP snippets per client, tabs by keyboard, copy feedback, toasts and the loading bar',async()=>{
 const origin='https://hub.example.lan';
 // The one-text form that the access page shows for a fresh key is unchanged.
 const text=ui.mcpSnippet('hhk_abc',origin);
 assert.match(text,/^# Claude Code\nclaude mcp add --transport http home-hub https:\/\/hub\.example\.lan\/mcp/);assert.match(text,/# Codex/);assert.match(text,/curl -s -H "Authorization: Bearer hhk_abc"/);
 const three=ui.mcpSnippets('hhk_abc',origin);
 assert.deepEqual(three.map(s=>s.id),['claude','codex','json']);
 assert.deepEqual(JSON.parse(three[2].text),{mcpServers:{'home-hub':{type:'http',url:`${origin}/mcp`,headers:{Authorization:'Bearer hhk_abc'}}}});
 for(const s of three)assert.ok(s.text.includes(`${origin}/mcp`)&&s.text.includes('hhk_abc'),s.id);
 assert.equal(byClass(ui.mcpConnect({origin}),'ui-copy-note').length,1,'a placeholder key says what to replace');
 assert.equal(byClass(ui.mcpConnect({origin,token:'hhk_real'}),'ui-copy-note').length,0);

 const seen=[];
 const group=ui.tabs({label:'Pick',items:[{id:'a',label:'A',content:()=>ui.statusPill('first')},{id:'b',label:'B',content:()=>ui.statusPill('second')}],onchange:id=>seen.push(id)});
 const [tabA,tabB]=all(group,n=>n.getAttribute?.('role')==='tab'),[panelA,panelB]=all(group,n=>n.getAttribute?.('role')==='tabpanel');
 assert.equal(panelA.textContent,'first');assert.equal(panelB.textContent,'','a panel is built when first shown');assert.ok(panelB.hasAttribute('hidden'));
 const list=all(group,n=>n.getAttribute?.('role')==='tablist')[0];
 for(const l of list.listeners.filter(l=>l.type==='keydown'))l.fn({key:'ArrowRight',preventDefault(){}});
 assert.equal(tabB.getAttribute('aria-selected'),'true');assert.equal(tabA.getAttribute('tabindex'),'-1');assert.ok(panelA.hasAttribute('hidden'));assert.equal(panelB.textContent,'second');
 for(const l of list.listeners.filter(l=>l.type==='keydown'))l.fn({key:'ArrowRight',preventDefault(){}});
 assert.equal(tabA.getAttribute('aria-selected'),'true','the arrow wraps around');assert.deepEqual(seen,['b','a']);

 // Copy: the button says what happened, for a working and a refused clipboard.
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{async writeText(v){navigator.copied=v;}}}});
 const block=ui.copyBlock('Prompt','copy me');const copy=byClass(block,'ui-button')[0];
 await copy.listeners.find(l=>l.type==='click').fn({});
 assert.equal(navigator.copied,'copy me');assert.ok(copy.classList.contains('done'));assert.equal(copy.textContent,'Copied');
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{async writeText(){throw new Error('denied');}}}});
 document.execCommand=()=>false;
 const refused=ui.copyButton(()=>'later');await refused.listeners.find(l=>l.type==='click').fn({});
 assert.equal(refused.textContent,'Copy failed');assert.ok(!refused.classList.contains('done'));

 const good=ui.toast.good('Saved.'),bad=ui.toast.bad('Not saved.',{timeout:0});
 const region=byClass(document.body,'ui-toasts')[0];
 assert.deepEqual(region.children.map(n=>[n.getAttribute('role'),n.classList.contains('good')||n.classList.contains('bad')]),[['status',true],['alert',true]]);
 good.close();bad.close();
 const done=ui.startLoading();assert.equal(byClass(document.body,'ui-progress').length,1);done();done();
 await ui.track(Promise.resolve(1));await assert.rejects(ui.track(Promise.reject(new Error('x'))),/x/,'track hands the promise back as it is');
});

test('icons: every page of the core has one, and a plugin entry gets its own, a glyph, or its initial',()=>{
 for(const hash of ['overview',...PAGES])assert.ok(ICONS.includes(pageIcon(hash)),hash);
 assert.equal(icon('search').getAttribute('aria-hidden'),'true');assert.equal(icon('search',{title:'Search'}).getAttribute('aria-label'),'Search');assert.equal(icon('nope'),null);
 assert.equal(byTag(navIcon({hash:'overview',label:'Overview'}),'svg').length,1);
 assert.equal(byTag(navIcon({hash:'notes',icon:'cpu',label:'Notes'}),'svg').length,1);
 assert.equal(navIcon({hash:'notes',icon:'✎',label:'Notes'}).textContent,'✎');
 const initial=navIcon({hash:'notes',label:'Notes'});assert.equal(initial.textContent,'N');assert.ok(initial.classList.contains('letter'));
});

test('command palette: matching ignores case and diacritics, needs every word, and puts a leading match first',()=>{
 const items=[{label:'Mapa inventáře',group:'Inventář'},{label:'Verze a aktualizace',group:'Inventář'},{label:'Uživatelé a API',group:'Správa'},{label:'Inventory export',group:'Tools'}];
 assert.equal(fold('Uživatelé'),'uzivatele');
 assert.deepEqual(matchItems(items,'').map(i=>i.label),items.map(i=>i.label),'nothing typed: everything, in order');
 assert.deepEqual(matchItems(items,'UZIV').map(i=>i.label),['Uživatelé a API']);
 assert.deepEqual(matchItems(items,'inv').map(i=>i.label),['Inventory export','Mapa inventáře','Verze a aktualizace'],'the group counts, a label that starts with the text leads');
 assert.deepEqual(matchItems(items,'inventar verze').map(i=>i.label),['Verze a aktualizace']);
 assert.deepEqual(matchItems(items,'nothing here'),[]);
});

test('getting started: each step is read from the hub, and a configured household is never nagged',()=>{
 const empty=onboardingSteps({home:{machines:[],router:null},accounts:{accounts:[]},inventory:null,systems:false,security:false});
 assert.deepEqual(empty.steps.map(s=>s.id),[...STEP_IDS]);
 assert.deepEqual(empty.steps.map(s=>s.done),[true,false,false,false,false,false]);
 assert.deepEqual(empty.steps.filter(s=>s.optional).map(s=>s.id),['telemetry','collectors']);
 assert.deepEqual([empty.requiredDone,empty.requiredTotal,empty.complete],[1,4,false]);

 const key=(revokedAt=null,lastUsedAt=null)=>({revokedAt,lastUsedAt});
 const agent=accounts=>onboardingSteps({home:{machines:[]},accounts:{accounts},inventory:null}).steps[1];
 assert.equal(agent([{name:'a',keys:[]}]).done,false,'an account without a key is not connected');
 assert.equal(agent([{name:'a',keys:[key('2026-01-01')]}]).done,false,'a revoked key does not count');
 assert.equal(agent([{name:'a',disabled:true,keys:[key()]}]).done,false,'nor does a disabled account');
 assert.deepEqual([agent([{name:'a',keys:[key()],lastUsedAt:null}]).done,agent([{name:'a',keys:[key()],lastUsedAt:null}]).detail.used],[true,false]);
 assert.equal(agent([{name:'a',keys:[key(null,'2026-01-02')],lastUsedAt:'2026-01-02'}]).detail.used,true);

 const set=onboardingSteps({home:{machines:[{id:'a',kind:'thermo',thermo:'up'},{id:'b',kind:'nas'}],router:{status:'ok'}},accounts:{accounts:[{name:'a',keys:[key()]}]},
  inventory:{doc:{entries:[{id:'a'},{id:'b'}]}},systems:true,security:false});
 assert.deepEqual(set.steps.map(s=>s.done),[true,true,true,true,true,true]);assert.equal(set.complete,true);
 assert.deepEqual([set.steps[2].detail.count,set.steps[3].detail.count,set.steps[4].detail.count],[2,1,2]);
 assert.deepEqual(set.steps[5].detail,{systems:true,security:false,router:true});

 // A viewer cannot list service accounts or collectors: unknown, and it does not hold the list open.
 const viewer=onboardingSteps({home:{machines:[{id:'a',kind:'other'}],router:null},inventory:{doc:{entries:[{id:'a'}]}}});
 assert.deepEqual(viewer.steps.map(s=>s.done),[true,null,true,false,true,false]);assert.equal(viewer.complete,true);
 assert.equal(onboardingSteps({}).steps[2].done,null,'no answer from the hub is unknown, not "empty"');

 assert.equal(offersOnboarding(empty,{edition:'public'}),true,'a new public hub is offered the list');
 assert.equal(offersOnboarding(empty,{edition:'private'}),true,'and so is a private tree with no machines yet');
 assert.equal(offersOnboarding(empty,{edition:'public',dismissed:true}),false);
 assert.equal(offersOnboarding(set,{edition:'public'}),false,'a finished hub is left alone');
 const household=onboardingSteps({home:{machines:[{id:'a',kind:'thermo'}]},accounts:{accounts:[]},inventory:null});
 assert.equal(household.complete,false);assert.equal(offersOnboarding(household,{edition:'private'}),false,'private edition with machines: only from the menu');
 assert.equal(offersOnboarding(household,{edition:'public'}),true);assert.equal(offersOnboarding(null,{edition:'public'}),false);

 const me={username:'alex'};localStorage.clear();
 assert.equal(isDismissed(me),false);setDismissed(me,true);assert.equal(isDismissed(me),true);assert.equal(isDismissed({username:'sam'}),false,'hidden per account');
 setDismissed(me,false);assert.equal(isDismissed(me),false);
});

// The checklist only wants to know whether something exists. It asks the routes that say so with a 200
// (a count, a collector state), never the data routes, which are 404 on a hub that is merely new: the
// browser logs every failed request, and a first visit would open on a console full of errors.
test('getting started on a brand-new hub: every read answers 200, and the steps still tick when data arrives',async t=>{
 const h=await hub(t);await rm(path.join(h.dir,'knowledge.json'));
 const get=(url,headers=h.admin)=>fetch(h.origin+url,{headers});
 for(const url of ['/api/inventory','/api/systems','/api/security'])assert.equal((await get(url)).status,404,`${url} is a 404 until something exists`);
 const schema=await get('/api/inventory/schema');assert.equal(schema.status,200);assert.deepEqual((await schema.json()).inventory,{entries:0,updatedAt:null});
 const state=await get('/api/collectors');assert.equal(state.status,200);
 const {collectors,schemaVersion}=await state.json();assert.equal(schemaVersion,1);
 assert.deepEqual(Object.keys(collectors),['systems','security','router']);
 assert.deepEqual([collectors.systems.state,collectors.systems.collectedAt,collectors.security.state,collectors.security.collectedAt],['waiting',null,'waiting',null],'the fixture site has machines to read, nothing read yet');
 assert.deepEqual(Object.keys(collectors.systems),['state','configured','collectedAt','ageSeconds','intervalSeconds','staleAfterSeconds','script'],'the state only, nothing of a snapshot');
 assert.ok(['not-configured','waiting'].includes(collectors.router.state));
 // Like the data routes: administrators and holders of security:read, nobody else.
 const reader=await h.account('reader',[]),auditor=await h.account('auditor',['security:read']);
 assert.equal((await get('/api/collectors',reader.headers)).status,403);assert.equal((await get('/api/collectors',auditor.headers)).status,200);
 assert.equal((await fetch(h.origin+'/api/collectors')).status,401);

 const {setPrincipal}=await import('../public/session-cache.js'),{loadOnboarding}=await import('../public/onboarding.js');
 const me=await (await get('/api/me')).json(),real=globalThis.fetch,seen=[];
 globalThis.fetch=async(url,init={})=>{const r=await real(h.origin+url,{...init,headers:{...init.headers,...h.admin}});seen.push([String(url),r.status]);return r;};
 t.after(()=>{globalThis.fetch=real;setPrincipal(null);});
 setPrincipal(me);
 const fresh=await loadOnboarding(me,{force:true});
 assert.deepEqual(seen.map(([url])=>url).sort(),['/api/admin/accounts','/api/collectors','/api/home','/api/inventory/schema']);
 assert.deepEqual(seen.filter(([,status])=>status!==200),[],'nothing for the console to log');
 const step=(status,id)=>status.steps.find(s=>s.id===id);
 assert.deepEqual([step(fresh,'inventory').done,step(fresh,'inventory').detail.count,step(fresh,'collectors').done],[false,0,false]);
 assert.deepEqual([step(fresh,'collectors').detail.systems,step(fresh,'collectors').detail.security],[false,false]);

 // An inventory entry and a key snapshot arrive: the same quiet reads see them.
 await writeFile(path.join(h.dir,'knowledge.json'),JSON.stringify({schema:1,updated_at:'2026-11-08',entries:[{id:'studio',kind:'machine',name:'Mac Studio',verified_at:'2026-11-08'}]}));
 await mkdir(path.join(h.dir,'security'),{recursive:true});
 await writeFile(path.join(h.dir,'security','ssh-keys.json'),JSON.stringify({schemaVersion:SECURITY_SCHEMA,collectedAt:new Date().toISOString(),machines:[],keys:[]}));
 seen.length=0;
 const later=await loadOnboarding(me,{force:true});
 assert.deepEqual(seen.filter(([,status])=>status!==200),[]);
 assert.deepEqual([step(later,'inventory').done,step(later,'inventory').detail.count,step(later,'collectors').done,step(later,'collectors').detail.security],[true,1,true,true]);
 const viewerSteps=onboardingSteps({home:{machines:[]},inventory:{inventory:{entries:3}}});
 assert.deepEqual([viewerSteps.steps[4].done,viewerSteps.steps[4].detail.count],[true,3],'the count comes from the schema route');
});

test('unreachable hub: a failed request marks it down, the next answer marks it back; other origins do not count',async()=>{
 const events=[];let mode='ok';
 const before={fetch:globalThis.fetch,dispatchEvent:globalThis.dispatchEvent,addEventListener:globalThis.addEventListener,location:globalThis.location};
 globalThis.dispatchEvent=e=>{if(e.type==='hubstate')events.push(e.detail.down);};globalThis.addEventListener=()=>{};globalThis.location={origin:'http://hub.test'};
 globalThis.fetch=async url=>{if(mode==='down')throw new TypeError('Failed to fetch');if(mode==='abort')throw Object.assign(new Error('aborted'),{name:'AbortError'});return {ok:mode==='ok',status:mode==='proxy'?502:mode==='ok'?200:503};};
 const net=await import('../public/net.js');
 net.watchNetwork();net.watchNetwork();// installing twice wraps once
 await fetch('/api/home');assert.equal(net.hubState().down,false);
 mode='down';await assert.rejects(fetch('https://elsewhere.example/x'));assert.equal(net.hubState().down,false,'another origin failing says nothing about the hub');
 mode='abort';await assert.rejects(fetch('/api/home'));assert.equal(net.hubState().down,false,'a cancelled request is not an outage');
 mode='down';await assert.rejects(fetch('/api/home'),TypeError);assert.equal(net.hubState().down,true);await assert.rejects(fetch('/api/home'));
 mode='busy';await fetch('/api/home');assert.equal(net.hubState().down,false,'a 503 is the hub answering');
 mode='proxy';await fetch('http://hub.test/api/home');assert.equal(net.hubState().down,true,'a 502 from the proxy in front is not');
 mode='ok';assert.equal(await net.pingHub(),true);assert.equal(net.hubState().down,false);
 assert.deepEqual(events,[true,false,true,false],'one event per change, none for repeats');
 Object.assign(globalThis,before);
});

test('server: the shell module serves its files, #welcome is a hidden page, a nav entry may carry an icon',async t=>{
 const shell=CORE_MODULES.find(m=>m.id==='shell');
 assert.ok(shell&&shell.core&&shell.routes.length===0,'the shell module adds no routes');
 const registry=createRegistry([...CORE_MODULES,defineModule({id:'p-one',nav:[{group:'P',hash:'p-page',label:'P page',icon:'cpu',view:'p.js#page'},{group:'P',hash:'p-two',label:'Two',view:'p.js#page'}],assets:['p.js']},{directory:null})]);
 const m=registry.manifest({role:'admin'});
 assert.deepEqual(m.nav.at(-1).items,[{hash:'p-page',label:'P page',labelKey:null,soon:false,module:'p-one',icon:'cpu'},{hash:'p-two',label:'Two',labelKey:null,soon:false,module:'p-one'}],'icon is passed on only when given');
 assert.ok(m.pages.some(p=>p.hash==='welcome'&&p.view.url==='/welcome-view.js'&&p.view.export==='welcomePage'));
 assert.ok(!m.nav.some(g=>g.items.some(i=>i.hash==='welcome')),'not in the sidebar: the shell offers it itself');
 assert.ok(PAGES.includes('welcome'));
 assert.throws(()=>defineModule({id:'p-one',nav:[{group:'P',hash:'p',label:'P',icon:'<b>',view:'p.js'}],assets:['p.js']},{directory:null}),/icon must be/);
 assert.throws(()=>defineModule({id:'p-one',nav:[{group:'P',hash:'p',label:'P',icon:7,view:'p.js'}],assets:['p.js']},{directory:null}),/icon must be/);

 const h=await hub(t);
 for(const file of ['/theme-boot.js','/theme.js','/icons.js','/palette.js','/net.js','/onboarding.js','/welcome-view.js','/hub.css','/tokens.css']){
  const r=await fetch(h.origin+file);assert.equal(r.status,200,file);assert.match(r.headers.get('content-type'),/javascript|css/,file);}
 assert.match((await fetch(h.origin+'/')).headers.get('content-security-policy'),/script-src 'self'; style-src 'self'/,'the page still allows no inline script or style');
 const manifest=await (await fetch(h.origin+'/api/ui/manifest',{headers:h.admin})).json();
 assert.ok(['public','private'].includes(manifest.edition));assert.ok(manifest.modules.some(x=>x.id==='shell'&&x.core),'the footer counts plugins from this list');
 // What the checklist reads is all there for an administrator, without a route of its own.
 for(const url of ['/api/home','/api/admin/accounts','/api/inventory'])assert.equal((await fetch(h.origin+url,{headers:h.admin})).status,200,url);
 assert.equal((await fetch(h.origin+'/api/onboarding',{headers:h.admin})).status,404);
});

test('shell: the pieces the app is built from are wired in, with text-safe DOM and no inline styles',async()=>{
 const app=await read('app.js');
 for(const piece of ["createPalette({","watchNetwork();","startLoading()","themeSwitch()","offersOnboarding(","document.title=pageTitle(machine,page)","manifest.version?","t('verze {version}',{version})","tp(plugins,"])assert.ok(app.includes(piece),piece);
 assert.match(app,/\(e\.metaKey\|\|e\.ctrlKey\)&&!e\.altKey&&!e\.shiftKey&&e\.key\.toLowerCase\(\)==='k'/,'Cmd/Ctrl-K opens the palette');
 assert.match(app,/const pref=\{get:key=>\{try\{return localStorage\.getItem\(key\);\}catch\{return null;\}\}/,'shell preferences survive refused storage');
 assert.doesNotMatch(app,/innerHTML|\.style\.|style:/,'text-safe DOM and no inline styles');
 for(const file of ['ui.js','palette.js','welcome-view.js','icons.js','net.js','onboarding.js','theme.js'])assert.doesNotMatch(await read(file),/\.innerHTML\s*=|insertAdjacentHTML\(|style:'/,file);
});
