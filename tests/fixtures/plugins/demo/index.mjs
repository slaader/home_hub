// A complete little plugin, used by tests/plugins.test.mjs and as the worked example in docs/plugins.md.
// It keeps a list of notes in memory: one scope, three routes, one MCP tool, one poller, one page.
export default {
 id:'demo',title:'Demo notes',
 scopes:{'demo:write':{label:'Demo – zápis',desc:'Přidávat poznámky v ukázkovém pluginu.'}},
 assets:['demo-view.js'],
 nav:[
  {group:'Demo',hash:'demo',label:'Notes',view:'demo-view.js#demoPage',order:60},
  {group:'Demo',hash:'demo-admin',label:'Admin notes',view:'demo-view.js#demoPage',admin:true,order:61},
  {group:'Demo',label:'Later',soon:true,order:62},
 ],
 strings:{en:{'Demo – zápis':'Demo – write','Přidávat poznámky v ukázkovém pluginu.':'Add notes in the demo plugin.'}},
 apiDocs:[{title:'Demo',routes:[['GET','/api/demo/notes','read','List the notes.'],['POST','/api/demo/notes','demo:write','Add a note {text}.']]}],
 // Once per hub. hub.options carries whatever the caller passed to createHandler (tests pass fakes).
 setup:hub=>({notes:[...(hub.options.demoNotes||[])],ticks:0,site:hub.site.siteName}),
 pollers:[{id:'tick',start:state=>{state.ticks++;},stop:state=>{state.stopped=true;}}],
 provides:{'home.snapshots':state=>({mini:{bridge:'demo',snapshot:null,notes:state.notes.length}})},
 routes:[
  {method:'GET',path:'/api/demo/notes',handler:({json,state})=>json(200,{notes:state.notes,site:state.site})},
  {method:'GET',match:/^\/api\/demo\/notes\/(\d+)$/,error:e=>e.message==='not-found'?[404,'DEMO_FAILED','No such note.']:null,
   handler({params,json,state}){const note=state.notes[Number(params[1])];if(note===undefined)throw new Error('not-found');return json(200,{note});}},
  {method:'POST',path:'/api/demo/notes',scope:'demo:write',handler(c){
    if(typeof c.input?.text!=='string'||!c.input.text.trim())return c.error(400,'DEMO_FAILED','text is required.');
    c.state.notes.push(c.input.text.trim());c.subject=`note-${c.state.notes.length}`;return c.json(201,{count:c.state.notes.length});}},
 ],
 mcpTools:[{name:'demo_notes',scope:'read',title:'Demo: notes',description:'The notes kept by the demo plugin.',
  inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true},
  run:(args,{state,principal})=>({notes:state.notes,for:principal.username})}],
};
