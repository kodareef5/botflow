// The operator web app, served at "/". One self-contained page, zero deps.
// Read-only on cards by design (agents mutate via API/CLI); admins manage
// spaces, projects, and agent keys, and watch boards + audit trails live.
// Palette matches the local viewer (validated in dogfood card 005).

const CSS = `
:root{color-scheme:light;
  --page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink-2:#52514e;--muted:#898781;
  --grid:#e1e0d9;--baseline:#c3c2b7;--ring:rgba(11,11,11,.10);
  --st-wishlist:#c3c2b7;--st-todo:#898781;--st-blocked:#d03b3b;--st-doing:#2a78d6;--st-done:#0ca30c;--st-archive:#e1e0d9;
  --progress:#2a78d6;--ready:#006300;--p0:#d03b3b;--p1:#ec835a}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;
  --page:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink-2:#c3c2b7;--muted:#898781;
  --grid:#2c2c2a;--baseline:#383835;--ring:rgba(255,255,255,.10);
  --st-wishlist:#383835;--st-archive:#2c2c2a;--st-doing:#3987e5;
  --progress:#3987e5;--ready:#0ca30c}}
:root[data-theme=dark]{color-scheme:dark;
  --page:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink-2:#c3c2b7;--muted:#898781;
  --grid:#2c2c2a;--baseline:#383835;--ring:rgba(255,255,255,.10);
  --st-wishlist:#383835;--st-archive:#2c2c2a;--st-doing:#3987e5;
  --progress:#3987e5;--ready:#0ca30c}
*{box-sizing:border-box;margin:0}
body{background:var(--page);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;height:100vh;display:flex;flex-direction:column}
button{font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--grid);border-radius:6px;padding:4px 10px;cursor:pointer}
button:hover{border-color:var(--baseline)}
button.primary{background:var(--progress);color:#fff;border-color:transparent}
input{font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--grid);border-radius:6px;padding:5px 8px}
header{display:flex;align-items:center;gap:18px;padding:12px 18px;border-bottom:1px solid var(--grid);flex:none}
header h1{font-size:16px}
header .sub{color:var(--muted);font-size:12px;font-weight:400}
.meter{display:flex;align-items:center;gap:8px}
.meter .track{width:130px;height:8px;border-radius:4px;background:var(--grid);overflow:hidden}
.meter .fill{height:100%;border-radius:4px;background:var(--progress)}
.strip{display:flex;gap:2px;height:10px;border-radius:4px;overflow:hidden;background:var(--grid);min-width:110px}
.strip i{display:block;height:100%;min-width:6px}
.chips{display:flex;gap:9px;flex-wrap:wrap;font-size:12px;color:var(--ink-2)}
.chips b{color:var(--ink)}
.chips .z{opacity:.45}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;border:1px solid var(--ring)}
.spacer{margin-left:auto}
.app{display:flex;flex:1;min-height:0}
aside{width:280px;flex:none;border-right:1px solid var(--grid);overflow-y:auto;padding:14px}
aside h2{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:14px 0 6px;display:flex;align-items:center}
aside h2 button{font-size:11px;padding:1px 7px;margin-left:auto}
.space{margin-bottom:4px}
.space>.row{font-weight:600}
.row{display:flex;align-items:center;gap:7px;padding:5px 7px;border-radius:7px;cursor:pointer;font-size:13px}
.row:hover{background:var(--surface)}
.row.sel{background:var(--surface);outline:1px solid var(--grid)}
.row .statechip{margin-left:auto}
.row .pct{color:var(--muted);font-size:11px}
.row .add{visibility:hidden;font-size:11px;padding:0 6px}
.row:hover .add{visibility:visible}
.kids{margin-left:14px;border-left:1px dashed var(--grid);padding-left:6px}
.statechip{font-size:10px;border-radius:999px;padding:1px 7px;color:#fff}
.statechip.s-wishlist,.statechip.s-archive,.statechip.s-todo{color:var(--ink)}
.statechip.s-wishlist{background:var(--st-wishlist)}.statechip.s-todo{background:var(--st-todo);color:#fff}
.statechip.s-blocked{background:var(--st-blocked)}.statechip.s-doing{background:var(--st-doing)}
.statechip.s-done{background:var(--st-done)}.statechip.s-archive{background:var(--st-archive)}
.content{flex:1;min-width:0;display:flex;flex-direction:column}
.phead{display:flex;align-items:center;gap:16px;padding:12px 18px;border-bottom:1px solid var(--grid);flex-wrap:wrap}
.phead h2{font-size:15px}
.tabs{display:flex;gap:2px;margin-left:auto}
.tabs button{border-radius:6px 6px 0 0;border-bottom:none}
.tabs button.on{background:var(--page);font-weight:600}
.view{flex:1;overflow:auto;padding:14px 18px}
.cols{display:flex;gap:12px;align-items:flex-start}
.col{background:var(--surface);border:1px solid var(--grid);border-radius:10px;min-width:255px;width:255px;flex:none;padding:9px}
.col h3{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2);padding:2px 4px 7px;display:flex;gap:6px}
.col h3 .n{color:var(--muted);font-weight:400}
.col h3 .wipbad{color:var(--p1)}
.sub-h{font-size:11px;color:var(--muted);padding:5px 4px 2px;border-top:1px dashed var(--grid);margin-top:5px}
.card{border:1px solid var(--grid);border-radius:8px;padding:7px 9px;margin:6px 0;background:var(--page);cursor:pointer}
.card:hover{border-color:var(--baseline)}
.card.blocked{border-left:3px solid var(--st-blocked)}
.card .cid{font:11px ui-monospace,Menlo,monospace;color:var(--muted)}
.card .t{font-weight:550;margin:1px 0 4px}
.badges{display:flex;flex-wrap:wrap;gap:5px;font-size:11px;color:var(--ink-2)}
.badges span{border:1px solid var(--grid);border-radius:999px;padding:1px 7px;background:var(--surface)}
.badges .ready{color:var(--ready);font-weight:650}
.badges .p0{color:var(--p0);font-weight:650}.badges .p1{color:var(--p1);font-weight:650}
.badges .blk{color:var(--st-blocked)}
.empty{color:var(--muted);font-size:12px;padding:5px}
table.list{border-collapse:collapse;width:100%;font-size:13px}
table.list td,table.list th{text-align:left;padding:6px 10px;border-bottom:1px solid var(--grid)}
table.list th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
table.list td.mono{font:12px ui-monospace,Menlo,monospace;color:var(--ink-2)}
#drawer{position:fixed;top:0;right:0;bottom:0;width:min(460px,92vw);background:var(--surface);border-left:1px solid var(--grid);box-shadow:-12px 0 30px rgba(0,0,0,.14);padding:20px;overflow-y:auto;display:none;z-index:10}
#drawer.open{display:block}
#drawer .close{float:right;border:none;background:none;font-size:17px;color:var(--muted)}
#drawer h2{font-size:15px;margin:2px 0 10px}
#drawer table{font-size:12px;border-collapse:collapse;margin:10px 0}
#drawer td{padding:2px 10px 2px 0;vertical-align:top;color:var(--ink-2)}
#drawer td:first-child{color:var(--muted)}
#drawer .body{border-top:1px solid var(--grid);margin-top:12px;padding-top:10px;font-size:13px}
#drawer .body h4{margin:11px 0 5px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2)}
#drawer .body ul{padding-left:20px;margin:4px 0}
#drawer .body li.done{color:var(--muted);text-decoration:line-through}
#drawer .body code{font:12px ui-monospace,Menlo,monospace;background:var(--page);border:1px solid var(--grid);border-radius:4px;padding:0 4px}
#drawer .body pre{background:var(--page);border:1px solid var(--grid);border-radius:6px;padding:9px;overflow-x:auto;font:12px ui-monospace,Menlo,monospace}
.gate{max-width:430px;margin:10vh auto;background:var(--surface);border:1px solid var(--grid);border-radius:12px;padding:26px}
.gate h2{margin-bottom:8px}
.gate p{color:var(--ink-2);font-size:13px;margin:6px 0 14px}
.gate form{display:flex;gap:8px}
.gate input{flex:1}
.gate .gatefoot{margin-top:18px;padding-top:13px;border-top:1px solid var(--grid);font-size:12px;color:var(--muted);line-height:1.7}
.gate .gatefoot a{color:var(--progress);text-decoration:none;font-weight:600}
.gate .gatefoot a:hover{text-decoration:underline}
.tokenbox{font:12px ui-monospace,Menlo,monospace;background:var(--page);border:1px solid var(--grid);border-radius:6px;padding:10px;word-break:break-all;margin:10px 0}
.warn{color:var(--p1);font-size:12px}
.err{color:var(--st-blocked);font-size:13px;margin-top:8px}
`;

const JS = `
const ORDER=['wishlist','todo','blocked','doing','done','archive'];
const $=(s,el)=>(el||document).querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct=p=>p==null?'—':Math.round(p*100)+'%';
let TOKEN=localStorage.getItem('bf_token')||'';
let ORG=null,SEL=null,TAB='board',BOARD=null,timer=null;
async function api(path,opts){
  const res=await fetch(path,{...opts,headers:{'content-type':'application/json',...(TOKEN?{authorization:'Bearer '+TOKEN}:{}),...(opts&&opts.headers||{})}});
  const body=await res.json().catch(()=>({}));
  if(!res.ok){const e=new Error(body.error||res.status);e.status=res.status;throw e}
  return body;
}
function strip(dist){
  return '<div class="strip">'+ORDER.map(s=>{const n=dist[s]||0;return n?'<i style="flex:'+n+' 1 0;background:var(--st-'+s+')" title="'+s+': '+n+'"></i>':''}).join('')+'</div>';
}
function chips(dist){
  return '<div class="chips">'+ORDER.map(s=>{const n=dist[s]||0;return '<span class="'+(n?'':'z')+'"><span class="dot" style="background:var(--st-'+s+')"></span>'+s+' <b>'+n+'</b></span>'}).join('')+'</div>';
}
function statechip(s){return '<span class="statechip s-'+s+'">'+s+'</span>'}
function md(src){
  const lines=esc(src).split('\\n');let out=[],list=null,fence=false;
  const flush=()=>{if(list){out.push('</ul>');list=null}};
  const inline=t=>t.replace(/\`([^\`]+)\`/g,'<code>$1</code>').replace(/\\*\\*([^*]+)\\*\\*/g,'<b>$1</b>');
  for(const l of lines){
    if(l.startsWith('\`\`\`')){flush();out.push(fence?'</pre>':'<pre>');fence=!fence;continue}
    if(fence){out.push(l);continue}
    const h=l.match(/^(#{1,4}) (.*)/);if(h){flush();out.push('<h4>'+inline(h[2])+'</h4>');continue}
    const ck=l.match(/^- \\[([ xX])\\] (.*)/);if(ck){if(!list){out.push('<ul>');list=1}out.push('<li class="'+(ck[1]!==' '?'done':'')+'">'+inline(ck[2])+'</li>');continue}
    const li=l.match(/^- (.*)/);if(li){if(!list){out.push('<ul>');list=1}out.push('<li>'+inline(li[1])+'</li>');continue}
    flush();if(l.trim()!=='')out.push('<p>'+inline(l)+'</p>');
  }
  flush();if(fence)out.push('</pre>');return out.join('\\n');
}
function gate(kind,extra){
  document.body.innerHTML='<div class="gate" id="gate"></div>';
  const g=$('#gate');
  if(kind==='setup'){
    g.innerHTML='<h2>Set up botflow manager</h2><p>Name your company to initialize this deployment. You will get the admin token exactly once.</p>'
      +'<form id="f"><input id="name" placeholder="company name" required><button class="primary">Initialize</button></form><div class="err" id="err"></div>';
    $('#f').onsubmit=async e=>{e.preventDefault();
      try{const r=await api('/api/setup',{method:'POST',body:JSON.stringify({name:$('#name').value})});
        g.innerHTML='<h2>Admin token</h2><p class="warn">Copy it now — it is never shown again.</p><div class="tokenbox">'+esc(r.token)+'</div>'
          +'<button class="primary" id="go">I saved it — continue</button>';
        $('#go').onclick=()=>{TOKEN=r.token;localStorage.setItem('bf_token',TOKEN);start()};
      }catch(err){$('#err').textContent=err.message}};
  }else{
    g.innerHTML='<h2>botflow manager</h2><p>Paste your admin token to open the operator view.'+(extra?' <span class="err">'+esc(extra)+'</span>':'')+'</p>'
      +'<form id="f"><input id="tok" placeholder="bfa_…" required><button class="primary">Open</button></form>';
    $('#f').onsubmit=e=>{e.preventDefault();TOKEN=$('#tok').value.trim();localStorage.setItem('bf_token',TOKEN);start()};
  }
  g.insertAdjacentHTML('beforeend','<div class="gatefoot">Git-native kanban for AI agents — agents work the board, you watch everything.<br>'
    +'Self-host free — one click on Cloudflare. <a href="https://github.com/kodareef5/botflow" target="_blank" rel="noopener">GitHub →</a></div>');
}
async function start(){
  clearInterval(timer);
  let org;
  try{org=await api('/api/org')}catch(err){
    if(err.status===401)return gate('token',TOKEN?'token rejected':null);
    return gate('token',err.message);
  }
  if(org.uninitialized)return gate('setup');
  ORG=org;
  if(!SEL){const first=firstProject(ORG);SEL=first?first.id:null}
  layout();
}
function firstProject(org){for(const s of org.spaces)if(s.projects.length)return s.projects[0];return null}
function findProject(id,nodes){for(const n of nodes||[]){if(n.id===id)return n;const d=findProject(id,n.children);if(d)return d}return null}
function selProject(){for(const s of ORG.spaces){const p=findProject(SEL,s.projects);if(p)return p}return null}
function layout(){
  const agg=ORG.aggregate;
  document.body.innerHTML=
    '<header><h1>'+esc(ORG.name)+' <span class="sub">botflow manager</span></h1>'
    +'<div class="meter"><div class="track"><div class="fill" style="width:'+Math.round((agg.progress||0)*100)+'%"></div></div><b>'+pct(agg.progress)+'</b></div>'
    +strip(agg.distribution)
    +'<span class="spacer"></span><button id="logout">log out</button></header>'
    +'<div class="app"><aside id="side"></aside><section class="content" id="main"></section></div><div id="drawer"></div>';
  $('#logout').onclick=()=>{localStorage.removeItem('bf_token');TOKEN='';gate('token')};
  renderSide();renderMain();
  timer=setInterval(()=>{if(TAB==='board'&&SEL)refreshBoard(true)},3000);
}
function projRow(n,depth){
  const a=n.aggregate;
  return '<div class="row '+(n.id===SEL?'sel':'')+'" data-proj="'+n.id+'">'
    +esc(n.name)+'<button class="add" data-addsub="'+n.id+'" title="add sub-project">+</button>'
    +'<span class="pct">'+pct(a.progress)+'</span>'+statechip(a.state)+'</div>'
    +(n.children.length?'<div class="kids">'+n.children.map(c=>projRow(c,depth+1)).join('')+'</div>':'');
}
function renderSide(){
  $('#side').innerHTML=ORG.spaces.map(s=>
    '<div class="space"><h2>'+esc(s.name)+' <span class="pct" style="margin-left:6px">'+pct(s.aggregate.progress)+'</span>'
    +'<button data-addproj="'+s.id+'">+ project</button></h2>'
    +(s.projects.length?s.projects.map(p=>projRow(p,0)).join(''):'<div class="empty">no projects</div>')
    +'</div>').join('')
    +'<h2>company <button id="addspace">+ space</button></h2>';
  $('#side').onclick=async e=>{
    const add=e.target.closest('[data-addproj]');
    if(add){const name=prompt('project name');if(name){await api('/api/projects',{method:'POST',body:JSON.stringify({space:add.dataset.addproj,name})});await start()}return}
    const sub=e.target.closest('[data-addsub]');
    if(sub){const name=prompt('sub-project name');if(name){const space=spaceOf(sub.dataset.addsub);await api('/api/projects',{method:'POST',body:JSON.stringify({space,parent:sub.dataset.addsub,name})});await start()}return}
    const row=e.target.closest('[data-proj]');
    if(row){SEL=row.dataset.proj;TAB='board';BOARD=null;renderSide();renderMain()}
  };
  const sp=$('#addspace');if(sp)sp.onclick=async()=>{const name=prompt('space name');if(name){await api('/api/spaces',{method:'POST',body:JSON.stringify({name})});await start()}};
}
function spaceOf(pid){for(const s of ORG.spaces)if(findProject(pid,s.projects))return s.id;return null}
function renderMain(){
  const main=$('#main');
  const p=selProject();
  if(!p){main.innerHTML='<div class="view"><div class="empty">Create a space and a project to begin. Agents connect with scoped keys via the REST API or <code>botflow push</code>.</div></div>';return}
  main.innerHTML='<div class="phead"><h2>'+esc(p.name)+'</h2><span class="pct" id="pinfo"></span>'
    +'<div class="tabs"><button data-tab="board" class="'+(TAB==='board'?'on':'')+'">board</button>'
    +'<button data-tab="activity" class="'+(TAB==='activity'?'on':'')+'">activity</button>'
    +'<button data-tab="keys" class="'+(TAB==='keys'?'on':'')+'">keys</button></div></div>'
    +'<div class="view" id="view">loading…</div>';
  main.querySelector('.tabs').onclick=e=>{const b=e.target.closest('[data-tab]');if(b){TAB=b.dataset.tab;renderMain()}};
  if(TAB==='board')refreshBoard();else if(TAB==='activity')refreshActivity();else refreshKeys();
}
function cardHtml(b,c){
  const ready=new Set(b.ready||[]);
  const badges=[];
  if(c.assignee)badges.push('<span>@'+esc(c.assignee)+'</span>');
  if(c.priority)badges.push('<span class="'+(c.priority==='p0'?'p0':c.priority==='p1'?'p1':'')+'">'+c.priority+'</span>');
  for(const l of c.labels||[])badges.push('<span>#'+esc(l)+'</span>');
  if(c.blocked)badges.push('<span class="blk" title="'+esc(c.blocked)+'">⛔ blocked</span>');
  if((c.deps||[]).length)badges.push('<span>deps→'+c.deps.map(esc).join(',')+'</span>');
  if(ready.has(c.id))badges.push('<span class="ready">▶ ready</span>');
  return '<div class="card '+(c.blocked?'blocked':'')+'" data-card="'+esc(c.id)+'"><div class="cid">'+esc(c.id)+'</div>'
    +'<div class="t">'+esc(c.title)+'</div><div class="badges">'+badges.join('')+'</div></div>';
}
async function refreshBoard(quiet){
  let b;try{b=await api('/api/projects/'+SEL+'/board')}catch(err){if(!quiet)$('#view').innerHTML='<div class="err">'+esc(err.message)+'</div>';return}
  if(quiet&&JSON.stringify(b)===JSON.stringify(BOARD))return;
  if($('#drawer').classList.contains('open'))return;
  BOARD=b;
  $('#pinfo').innerHTML=b.cards+' cards · '+pct(b.progress);
  const errs=(b.findings||[]).filter(f=>f.severity==='error').length;
  $('#view').innerHTML=chips(b.distribution)+(errs?'<div class="err">'+errs+' lint error(s)</div>':'')
    +'<div class="cols" style="margin-top:12px">'+b.lanes.map(lane=>{
      const n=lane.cards.length;
      const wip=lane.wip!=null?'<span class="'+(n>lane.wip?'wipbad':'n')+'">'+n+'/'+lane.wip+'</span>':'<span class="n">'+n+'</span>';
      let body='';
      if(lane.substates.length){
        for(const sub of lane.substates){
          const cs=lane.cards.filter(c=>c.substate===sub||(sub===lane.substates[0]&&c.substate==null));
          if(cs.length)body+='<div class="sub-h">· '+esc(sub)+'</div>'+cs.map(c=>cardHtml(b,c)).join('');
        }
      }else body=lane.cards.map(c=>cardHtml(b,c)).join('');
      return '<section class="col"><h3>'+esc(lane.name)+' '+wip+'</h3>'+(body||'<div class="empty">—</div>')+'</section>';
    }).join('')+'</div>';
  $('#view').onclick=e=>{
    const el=e.target.closest('[data-card]');if(!el)return;
    for(const lane of BOARD.lanes){const c=lane.cards.find(x=>x.id===el.dataset.card);if(c)return openDrawer(c)}
  };
}
function openDrawer(c){
  const d=$('#drawer');
  const rows=[['position',c.position],['state',c.state],['assignee',c.assignee],['priority',c.priority],
    ['labels',(c.labels||[]).join(', ')],['deps',(c.deps||[]).join(', ')],['blocked',c.blocked],
    ['created',c.created],['updated',c.updated],['file',c.file]].filter(r=>r[1]);
  d.innerHTML='<button class="close">✕</button><div class="cid">'+esc(c.id)+'</div><h2>'+esc(c.title)+'</h2>'+statechip(c.state)
    +'<table>'+rows.map(r=>'<tr><td>'+r[0]+'</td><td>'+esc(r[1])+'</td></tr>').join('')+'</table>'
    +'<div class="body">'+(c.body&&c.body.trim()?md(c.body):'<p class="empty">no body</p>')+'</div>';
  d.classList.add('open');
  d.querySelector('.close').onclick=()=>d.classList.remove('open');
}
document.addEventListener('keydown',e=>{if(e.key==='Escape'){const d=$('#drawer');if(d)d.classList.remove('open')}});
async function refreshActivity(){
  try{const ev=await api('/api/projects/'+SEL+'/events?limit=200');
    $('#view').innerHTML=ev.length?'<table class="list"><tr><th>when</th><th>actor</th><th>action</th><th>card</th><th>detail</th></tr>'
      +ev.map(e=>'<tr><td class="mono">'+esc((e.ts||'').replace('T',' ').slice(0,16))+'</td><td>'+esc(e.actor)+'</td><td>'+esc(e.action)+'</td><td class="mono">'+esc(e.card_id||'')+'</td><td>'+esc(e.detail)+'</td></tr>').join('')+'</table>'
      :'<div class="empty">no activity yet</div>';
  }catch(err){$('#view').innerHTML='<div class="err">'+esc(err.message)+'</div>'}
}
async function refreshKeys(){
  try{
    const keys=await api('/api/projects/'+SEL+'/keys');
    $('#view').innerHTML='<p style="margin-bottom:10px"><button class="primary" id="mk">+ agent key</button>'
      +' <span class="sub" style="color:var(--muted);font-size:12px">scoped to this project; agents send it as a Bearer token</span></p>'
      +(keys.length?'<table class="list"><tr><th>label</th><th>id</th><th>created</th><th></th></tr>'
        +keys.map(k=>'<tr'+(k.revoked?' style="opacity:.5"':'')+'><td>'+esc(k.label)+'</td><td class="mono">'+esc(k.id)+'</td><td class="mono">'+esc(k.created.slice(0,10))+'</td>'
          +'<td>'+(k.revoked?'revoked':'<button data-rk="'+esc(k.id)+'">revoke</button>')+'</td></tr>').join('')+'</table>'
        :'<div class="empty">no keys yet</div>');
    $('#mk').onclick=async()=>{const label=prompt('key label (used as the agent actor name)');if(!label)return;
      const r=await api('/api/projects/'+SEL+'/keys',{method:'POST',body:JSON.stringify({label})});
      $('#view').insertAdjacentHTML('afterbegin','<div class="tokenbox">'+esc(r.token)+'</div><p class="warn">Copy this agent key now — it is never shown again.</p>');
      };
    $('#view').addEventListener('click',async e=>{const b=e.target.closest('[data-rk]');if(b){await api('/api/keys/'+b.dataset.rk+'/revoke',{method:'POST'});refreshKeys()}});
  }catch(err){$('#view').innerHTML='<div class="err">'+esc(err.message)+'</div>'}
}
start();
`;

export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>botflow manager</title>
<style>${CSS}</style>
</head>
<body>
<script>${JS}</script>
</body>
</html>`;
