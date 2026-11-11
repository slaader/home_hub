// Git LFS → Add / edit connection: one dialog in four steps. 1. the kind of host and its address (GitHub's is
// fixed, GitHub Enterprise optional), 2. the token: which permissions it needs, where to create it, and
// "Test connection" (who it is, which scopes the host reports, what this kind of host can do), 3. which
// repositories (all the token sees, all of one owner, or picked from a list), 4. save. The token goes to the
// server once, on test and on save; it is never shown again (an edit leaves the field empty = keep it).
import {el} from './views.js';
import {authGuard} from './session-cache.js';
import {t,tp} from './i18n.js';
import {statusPill} from './ui.js';
// replaceChildren() would print null/false as text; drop empty children the way el() does.
const put=(node,...kids)=>node.replaceChildren(...kids.flat(Infinity).filter(k=>k!==undefined&&k!==null&&k!==false));

async function post(url,body){
 const lost=authGuard(),r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});lost(r);
 const d=await r.json().catch(()=>({}));
 if(!r.ok)throw new Error([d.error?.message?t(d.error.message):t('Požadavek selhal.'),...(Array.isArray(d.error?.details)?d.error.details:[])].join(' '));
 return d;
}
// What a person typed → the host's web address, as the server will store it (no trailing slash, no /api/vN).
export function webAddress(provider,value){
 const raw=String(value||'').trim();
 if(!raw)return provider?.fixedBaseUrl||'';
 try{const u=new URL(raw);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)return null;
  return (u.origin+u.pathname.replace(/\/+$/,'')).replace(/\/api\/v[13]$/i,'');}catch{return null;}
}
export const tokenUrl=(provider,web)=>provider?.token?.url&&(!web||web===provider.fixedBaseUrl)?provider.token.url:provider?.token?.urlTemplate&&web?provider.token.urlTemplate.replace('{web}',web):null;
// Where to click to make a read-only token on a host of this kind (the provider's steps), or general steps for a
// host Home Hub has no provider for. Used by the wizard's token step and the empty Git LFS page.
export const OTHER_HOST_STEPS=['V nastavení svého účtu najdi Access tokens nebo Personal access tokens (obvykle Settings → Applications, nebo Settings → Developer settings).',
 'Vytvoř token, který smí jen číst repozitáře (a vidět tvůj účet a organizace). Zápis ani mazání nepovoluj.',
 'Token hned zkopíruj: hosty ho obvykle ukážou jen jednou.'];
export const tokenSteps=steps=>steps?.length?el('ol',{class:'gl-steps'},steps.map(x=>el('li',{},t(x)))):null;
export function tokenGuides(providers=[]){
 return el('div',{class:'gl-guides'},el('h3',{},t('Jak vytvořit token jen pro čtení')),
  ...providers.filter(p=>p?.token?.steps?.length).map(p=>el('details',{class:'gl-guide'},el('summary',{},p.title),tokenSteps(p.token.steps),
   el('ul',{class:'gl-perms'},(p.token.permissions||[]).map(x=>el('li',{},t(x)))))),
  el('details',{class:'gl-guide'},el('summary',{},t('Jiný git host')),tokenSteps(OTHER_HOST_STEPS),el('p',{class:'gl-hint'},t('Host, který Home Hub nezná (třeba GitLab), přidá plugin; jeho kroky se pak ukážou tady.'))));
}
const CAPS=[['listRepos','Výpis repozitářů'],['checkObjects','Ověření, že host objekt má (LFS batch API)'],['listObjects','Výpis všech LFS objektů přes API'],['deleteObjects','Mazání LFS objektů přes API'],['tokenScopes','Host vypíše oprávnění tokenu']];
export const capabilityList=caps=>el('ul',{class:'gl-caps'},CAPS.map(([k,label])=>el('li',{class:caps?.[k]?'yes':'no'},el('span',{'aria-hidden':'true'},caps?.[k]?'✓':'—'),' ',t(label),el('span',{class:'ui-sr'},caps?.[k]?t('ano'):t('ne')))));

/**
 * providers = GET /api/git-lfs → providers; connection = an existing one to edit (or null);
 * onSaved(connection) after a successful save.
 */
export function openWizard({providers=[],connection=null,onSaved}={}){
 const editing=Boolean(connection);
 let tested=null,repoList=[],busy=false;
 const field=(label,input,hint)=>el('label',{class:'gl-field'},el('span',{class:'gl-label'},label),input,hint?el('span',{class:'gl-hint'},hint):null);
 const name=el('input',{type:'text',maxlength:'80',autocomplete:'off',value:connection?.name||''});
 const kind=el('select',{},providers.map(p=>el('option',{value:p.id},p.title)));kind.value=connection?.provider||providers[0]?.id||'';
 const enterprise=el('input',{type:'checkbox'});
 const base=el('input',{type:'url',inputmode:'url',autocomplete:'off',placeholder:'https://git.example.lan',spellcheck:'false'});
 const token=el('input',{type:'password',autocomplete:'new-password',spellcheck:'false',placeholder:editing?t('Prázdné = ponechat uložený token'):''});
 const mode=el('select',{},el('option',{value:'all'},t('Všechny, které token vidí')),el('option',{value:'owner'},t('Všechny jednoho vlastníka nebo organizace')),el('option',{value:'selected'},t('Vybrané')));
 const owner=el('input',{type:'text',autocomplete:'off',placeholder:'alice',spellcheck:'false'});
 const filter=el('input',{type:'search',placeholder:t('Filtrovat repozitáře…'),'aria-label':t('Filtrovat repozitáře')});
 const picked=new Set(connection?.repos||[]);
 mode.value=connection?.repoMode||'selected';owner.value=connection?.owner||'';
 const provider=()=>providers.find(p=>p.id===kind.value)||null;
 if(connection){const p=providers.find(x=>x.id===connection.provider);if(p?.fixedBaseUrl&&connection.baseUrl!==p.fixedBaseUrl){enterprise.checked=true;base.value=connection.baseUrl;}else if(!p?.fixedBaseUrl)base.value=connection.baseUrl||'';}

 const hostBox=el('div',{class:'gl-sec'}),tokenBox=el('div',{class:'gl-sec'}),testOut=el('div',{class:'gl-test',role:'status','aria-live':'polite'}),repoBox=el('div',{class:'gl-sec'});
 const status=el('p',{class:'gl-status',role:'status','aria-live':'polite'});
 const say=(text,bad=false)=>{status.textContent=text;status.classList.toggle('bad',bad);};
 const web=()=>{const p=provider();return p?.fixedBaseUrl&&!enterprise.checked?p.fixedBaseUrl:webAddress(p,base.value);};
 // What the server needs to find the host: the base URL (unless fixed), the new token, or this connection's stored one.
 const target=()=>{const p=provider(),b=p?.fixedBaseUrl&&!enterprise.checked?undefined:base.value.trim();
  return {provider:kind.value,...(b?{baseUrl:b}:{}),...(token.value?{token:token.value}:connection?{connection:connection.id}:{})};};
 const sameHost=()=>connection&&connection.provider===kind.value&&web()===connection.baseUrl;

 function paintHost(){
  const p=provider();
  put(hostBox,el('h3',{},t('1. Host')),
   field(t('Druh hostu'),kind),
   p?.fixedBaseUrl?el('label',{class:'gl-check'},enterprise,' ',t('GitHub Enterprise Server (vlastní adresa)')):null,
   !p?.fixedBaseUrl||enterprise.checked?field(t('Adresa hostu'),base,p?.fixedBaseUrl?t('Například https://github.example.lan. API je na /api/v3.'):t('Adresa webového rozhraní, například https://git.example.lan. API je na /api/v1.')):el('p',{class:'gl-hint'},t('Adresa: {url}',{url:p.fixedBaseUrl})),
   /^http:/.test(web()||'')?el('p',{class:'gl-warn'},t('Adresa je http: token půjde po síti nešifrovaně. Použij https, pokud to host umí.')):null,
   field(t('Název připojení'),name,t('Jak se připojení jmenuje v hubu, například „Domácí Forgejo“.')),
   el('div',{class:'gl-provider-caps'},el('span',{class:'gl-label'},t('Co tenhle druh hostu umí')),capabilityList(p?.capabilities),p?.token?.note?el('p',{class:'gl-hint'},t(p.token.note)):null));
  paintToken();
 }
 function paintToken(){
  const p=provider(),url=tokenUrl(p,web());
  put(tokenBox,el('h3',{},t('2. Token')),
   p?.token?.steps?.length?el('details',{class:'gl-guide',open:''},el('summary',{},t('Jak token vytvořit')),tokenSteps(p.token.steps)):null,
   el('p',{class:'gl-note'},t('Hubu stačí token jen pro čtení. Potřebná oprávnění:')),
   el('ul',{class:'gl-perms'},(p?.token?.permissions||[]).map(x=>el('li',{},t(x)))),
   url?el('p',{},el('a',{class:'gl-link',href:url,target:'_blank',rel:'noopener noreferrer'},t('Vytvořit token na hostu ↗'))):el('p',{class:'gl-hint'},t('Odkaz na vytvoření tokenu se ukáže po zadání adresy.')),
   field(t('Token'),token,editing?t('Uložený token se nikdy nezobrazí. Při změně hostu je potřeba nový.'):t('Uloží se jen na serveru (soubor s právy 0600) a nikdy se nezobrazí ani nezapíše do logu.')),
   el('div',{class:'gl-row'},el('button',{type:'button',class:'ui-button',onclick:runTest},t('Otestovat připojení'))),testOut);
 }
 function paintTest(){
  if(!tested){put(testOut);return;}
  put(testOut,
   el('p',{},statusPill(t('Připojeno'),'good'),' ',t('Přihlášen jako {login}',{login:tested.user.login}),tested.user.name?' ('+tested.user.name+')':''),
   tested.scopes?el('p',{class:'gl-note'},t('Oprávnění tokenu: {scopes}',{scopes:tested.scopes.join(', ')||t('žádná')})):el('p',{class:'gl-hint'},t(tested.scopesNote||'Host oprávnění tokenu nevypisuje.')),
   ...(tested.warnings||[]).map(w=>el('p',{class:'gl-warn'},t(w))),
   tested.git&&!tested.git.ok?el('p',{class:'gl-warn'},t('Na serveru hubu chybí git; repozitáře se nenaskenují.')):null);
 }
 async function runTest(){
  if(busy)return;busy=true;say(t('Ověřuji token…'));put(testOut);
  try{tested=await post('/api/git-lfs/test',target());paintTest();say('');if(!name.value.trim())name.value=provider()?.title+' · '+tested.user.login;}
  catch(e){tested=null;say(e.message,true);}finally{busy=false;}
 }
 function paintRepos(){
  const q=filter.value.trim().toLowerCase();
  const rows=repoList.filter(r=>!q||r.fullName.toLowerCase().includes(q)).slice(0,300);
  const list=el('div',{class:'gl-repo-list',role:'group','aria-label':t('Repozitáře')},rows.map(r=>{
   const box=el('input',{type:'checkbox',value:r.fullName,onchange:()=>{box.checked?picked.add(r.fullName):picked.delete(r.fullName);count.textContent=tp(picked.size,'{n} vybraný|{n} vybrané|{n} vybraných');}});box.checked=picked.has(r.fullName);
   return el('label',{class:'gl-check'},box,' ',el('span',{class:'gl-mono'},r.fullName),r.private?' '+t('soukromý'):'',r.archived?' · '+t('archivovaný'):'');}));
  const count=el('span',{class:'gl-hint'},tp(picked.size,'{n} vybraný|{n} vybrané|{n} vybraných'));
  put(repoBox,el('h3',{},t('3. Repozitáře')),field(t('Které repozitáře'),mode),
   mode.value==='owner'?field(t('Vlastník nebo organizace'),owner):null,
   mode.value==='all'?el('p',{class:'gl-hint'},t('Hub při každém skenu vezme všechny repozitáře, které token vidí (nejvýš 200).')):null,
   mode.value!=='all'?el('div',{class:'gl-row'},el('button',{type:'button',class:'ui-button',onclick:loadRepos},t('Načíst repozitáře')),mode.value==='selected'?count:null):null,
   mode.value==='selected'&&repoList.length?filter:null,
   mode.value==='selected'?(repoList.length?list:picked.size?el('p',{class:'gl-hint'},[...picked].join(', ')):null):
   mode.value==='owner'&&repoList.length?el('p',{class:'gl-hint'},tp(repoList.length,'Vlastník má {n} repozitář.|Vlastník má {n} repozitáře.|Vlastník má {n} repozitářů.')):null);
 }
 async function loadRepos(){
  if(busy)return;busy=true;say(t('Načítám repozitáře…'));
  try{const d=await post('/api/git-lfs/repos',{...target(),...(mode.value==='owner'&&owner.value.trim()?{owner:owner.value.trim()}:{})});repoList=d.repos;say(d.truncated?t('Repozitářů je víc než 1000; ukazuji prvních 1000.'):'');paintRepos();}
  catch(e){say(e.message,true);}finally{busy=false;}
 }
 async function submit(){
  if(busy)return;
  const p=provider();if(!p)return say(t('Vyber druh hostu.'),true);
  if(!name.value.trim())return say(t('Vyplň název připojení.'),true);
  if((!p.fixedBaseUrl||enterprise.checked)&&!webAddress(p,base.value))return say(t('Adresa hostu má tvar https://host.'),true);
  if(!token.value&&!sameHost())return say(editing?t('Host se změnil: zadej pro něj nový token.'):t('Zadej token.'),true);
  if(mode.value==='owner'&&!owner.value.trim())return say(t('Vyplň vlastníka nebo organizaci.'),true);
  if(mode.value==='selected'&&!picked.size)return say(t('Vyber aspoň jeden repozitář.'),true);
  busy=true;save.disabled=true;say(t('Ověřuji token a ukládám…'));
  try{
   const b=p.fixedBaseUrl&&!enterprise.checked?undefined:base.value.trim();
   const d=await post('/api/git-lfs/connections',{...(connection?{id:connection.id}:{}),provider:p.id,name:name.value.trim(),...(b?{baseUrl:b}:{}),...(token.value?{token:token.value}:{}),
    repoMode:mode.value,...(mode.value==='owner'?{owner:owner.value.trim()}:{}),...(mode.value==='selected'?{repos:[...picked]}:{})});
   token.value='';dialog.close();onSaved?.(d.connection);
  }catch(e){say(e.message,true);save.disabled=false;}finally{busy=false;}
 }
 kind.addEventListener('change',()=>{tested=null;repoList=[];paintHost();paintTest();paintRepos();});
 enterprise.addEventListener('change',paintHost);
 base.addEventListener('change',()=>{tested=null;paintHost();paintTest();});
 mode.addEventListener('change',paintRepos);filter.addEventListener('input',paintRepos);
 const save=el('button',{type:'button',class:'ui-button primary',onclick:submit},editing?t('Uložit změny'):t('Uložit připojení'));
 const dialog=el('dialog',{class:'gl-dialog','aria-labelledby':'gl-wizard-title'},
  el('div',{class:'gl-dialog-head'},el('div',{},el('h2',{id:'gl-wizard-title'},editing?t('Upravit připojení'):t('Přidat připojení ke git hostu')),
   el('p',{class:'gl-hint'},t('Hub repozitáře jen čte: stáhne si jejich git historii bez velkých souborů a zjistí, kde se který LFS objekt používá.'))),
   el('button',{type:'button',class:'gl-close','aria-label':t('Zavřít'),onclick:()=>dialog.close()},'×')),
  el('div',{class:'gl-dialog-body'},hostBox,tokenBox,repoBox),
  el('div',{class:'gl-dialog-foot'},status,el('div',{class:'gl-row'},el('button',{type:'button',class:'ui-button',onclick:()=>dialog.close()},t('Zrušit')),save)));
 dialog.addEventListener('close',()=>{token.value='';dialog.remove();});
 paintHost();paintRepos();
 document.body.append(dialog);dialog.showModal();name.focus();
 return dialog;
}
