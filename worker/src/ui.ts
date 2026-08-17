// The operator web app, served at "/". One self-contained page, zero deps.
// Structure is one stylesheet driven entirely by CSS variables; the five
// styles in themes.ts repaint and reshape it (radius, borders, shadows, font)
// without touching markup. Cards open into a large tabbed modal (details,
// chat, activity) with checklists, attachments, galleries, and cover art,
// all stored in the card's markdown body (file-format truth).

import { STYLES } from './themes.ts';

const CSS = `
*{box-sizing:border-box;margin:0}
:root{--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;
  --grid:#e1e0d9;--baseline:#c3c2b7;--ring:rgba(11,11,11,.10);--acc:#2a78d6;--acc-ink:#fff;
  --st-wishlist:#c3c2b7;--st-todo:#898781;--st-blocked:#d03b3b;--st-doing:#2a78d6;--st-done:#0ca30c;--st-archive:#e1e0d9;
  --rc:10px;--rk:6px;--bw:1px;--bs:solid;--shadow:0 1px 3px rgba(0,0,0,.06);
  --font:system-ui,-apple-system,"Segoe UI",sans-serif}
#burger{display:none}
body{background:var(--page);color:var(--ink);font:14px/1.45 var(--font);height:100vh;display:flex;flex-direction:column}
button{font:inherit;color:var(--ink);background:var(--surface);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rk);padding:4px 11px;cursor:pointer}
button:hover{border-color:var(--baseline)}
button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
button.primary{background:var(--acc);color:var(--acc-ink);border-color:transparent}
button.ghost{border-color:transparent;background:none;color:var(--muted)}
button.ghost:hover{color:var(--ink)}
input,textarea{font:inherit;color:var(--ink);background:var(--surface);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rk);padding:6px 9px}
svg.ic{width:13px;height:13px;vertical-align:-2px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
header.top{display:flex;align-items:center;gap:18px;padding:12px 18px;border-bottom:var(--bw) var(--bs) var(--grid);flex:none;background:var(--page)}
header.top h1{font-size:16px}
header.top .sub{color:var(--muted);font-size:12px;font-weight:400}
.meter{display:flex;align-items:center;gap:8px}
.meter .track{width:130px;height:8px;border-radius:4px;background:var(--grid);overflow:hidden}
.meter .fill{height:100%;border-radius:4px;background:var(--acc)}
.strip{display:flex;gap:2px;height:10px;border-radius:4px;overflow:hidden;background:var(--grid);min-width:110px}
.strip i{display:block;height:100%;min-width:6px}
.chips{display:flex;gap:9px;flex-wrap:wrap;font-size:12px;color:var(--ink2)}
.chips b{color:var(--ink)}
.chips .z{opacity:.45}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;border:1px solid var(--ring)}
.spacer{margin-left:auto}
.app{display:flex;flex:1;min-height:0}
aside{width:280px;flex:none;border-right:var(--bw) var(--bs) var(--grid);overflow-y:auto;padding:14px;display:flex;flex-direction:column}
aside h2{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:14px 0 6px;display:flex;align-items:center}
aside h2 button{font-size:11px;padding:1px 7px;margin-left:auto}
.row{display:flex;align-items:center;gap:7px;padding:5px 7px;border-radius:var(--rk);cursor:pointer;font-size:13px}
.row:hover{background:var(--surface)}
.row.sel{background:var(--surface);outline:var(--bw) var(--bs) var(--grid)}
.row .statechip{margin-left:auto}
.row .pct{color:var(--muted);font-size:11px}
.row .add{visibility:hidden;font-size:11px;padding:0 6px}
.row:hover .add{visibility:visible}
.kids{margin-left:14px;border-left:1px dashed var(--grid);padding-left:6px}
.sidefoot{margin-top:auto;padding-top:14px}
.statechip{font-size:10px;border-radius:999px;padding:1px 7px;color:#fff;white-space:nowrap}
.statechip.s-wishlist{background:var(--st-wishlist);color:var(--ink)}
.statechip.s-todo{background:var(--st-todo)}
.statechip.s-blocked{background:var(--st-blocked)}
.statechip.s-doing{background:var(--st-doing)}
.statechip.s-done{background:var(--st-done)}
.statechip.s-archive{background:var(--st-archive);color:var(--ink)}
.content{flex:1;min-width:0;display:flex;flex-direction:column}
.phead{display:flex;align-items:center;gap:16px;padding:12px 18px;border-bottom:var(--bw) var(--bs) var(--grid);flex-wrap:wrap}
.phead h2{font-size:15px}
.tabs{display:flex;gap:2px;margin-left:auto}
.tabs button.on{background:var(--acc);color:var(--acc-ink);border-color:transparent}
.view{flex:1;overflow:auto;padding:14px 18px}
.cols{display:flex;gap:12px;align-items:flex-start}
.col{background:var(--surface);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);min-width:258px;width:258px;flex:none;padding:9px;box-shadow:var(--shadow)}
.col h3{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink2);padding:2px 4px 7px;display:flex;gap:6px}
.col h3 .n{color:var(--muted);font-weight:400}
.col h3 .wipbad{color:var(--st-blocked)}
.sub-h{font-size:11px;color:var(--muted);padding:5px 4px 2px;border-top:1px dashed var(--grid);margin-top:5px}
.card{border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);margin:7px 0;background:var(--page);cursor:pointer;overflow:hidden}
.card:hover{border-color:var(--baseline)}
.card.blocked{border-left:3px solid var(--st-blocked)}
.card .art{width:100%;height:92px;object-fit:cover;display:block;border-bottom:var(--bw) var(--bs) var(--grid)}
.card .inner{padding:7px 10px 8px}
.card .cid{font:11px ui-monospace,Menlo,monospace;color:var(--muted)}
.card .t{font-weight:550;margin:1px 0 5px}
.badges{display:flex;flex-wrap:wrap;gap:5px;font-size:11px;color:var(--ink2);align-items:center}
.badges span{border:var(--bw) var(--bs) var(--grid);border-radius:999px;padding:1px 7px;background:var(--surface);display:inline-flex;gap:4px;align-items:center}
.badges .bare{border:none;background:none;padding:1px 2px}
.badges .ready{color:var(--st-done);font-weight:650}
.badges .p0{color:var(--st-blocked);font-weight:650}
.badges .p1{color:#c47317;font-weight:650}
.badges .blk{color:var(--st-blocked)}
.badges .ok{color:var(--st-done)}
.subboard{margin:7px 0 0;display:flex;gap:8px;align-items:center}
.subboard button{font-size:12px;padding:2px 8px}
.subboard .mini{flex:1;height:6px;border-radius:3px;background:var(--grid);overflow:hidden}
.subboard .mini i{display:block;height:100%;background:var(--acc)}
.empty{color:var(--muted);font-size:12px;padding:6px 4px}
table.list{border-collapse:collapse;width:100%;font-size:13px}
table.list td,table.list th{text-align:left;padding:6px 10px;border-bottom:var(--bw) var(--bs) var(--grid)}
table.list th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
table.list td.mono{font:12px ui-monospace,Menlo,monospace;color:var(--ink2)}
.err{color:var(--st-blocked);font-size:13px;margin-top:8px}
.warn{color:#c47317;font-size:12px}
.tokenbox{font:12px ui-monospace,Menlo,monospace;background:var(--page);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rk);padding:10px;word-break:break-all;margin:10px 0}
.gate{max-width:430px;margin:10vh auto;background:var(--surface);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);padding:26px;box-shadow:var(--shadow)}
.gate h2{margin-bottom:8px}
.gate p{color:var(--ink2);font-size:13px;margin:6px 0 14px}
.gate form{display:flex;gap:8px}
.gate input{flex:1}
.gate .gatefoot{margin-top:16px;padding-top:12px;border-top:var(--bw) var(--bs) var(--grid);font-size:11.5px;color:var(--muted);line-height:1.7;opacity:.85}
.gate .gatefoot a{color:var(--muted);text-decoration:underline;text-underline-offset:2px;font-weight:500}
.gate .gatefoot a:hover{color:var(--ink2)}
.gateshares{margin-top:14px;font-size:12px;display:flex;gap:7px;flex-wrap:wrap;align-items:center}
.gateshares .lbl{color:var(--muted);text-transform:uppercase;letter-spacing:.05em;font-size:10.5px}
.gateshares a{color:var(--ink2);text-decoration:none;border:var(--bw) var(--bs) var(--grid);border-radius:999px;padding:2px 10px;background:var(--page)}
.gateshares a:hover{border-color:var(--baseline);color:var(--ink)}
.pubfoot{padding:10px 18px;border-top:var(--bw) var(--bs) var(--grid);font-size:11.5px;color:var(--muted)}
.pubfoot a{color:var(--muted);text-decoration:underline;text-underline-offset:2px}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:flex-start;justify-content:center;padding:5vh 16px;z-index:20;overflow-y:auto}
.modal{background:var(--surface);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);box-shadow:var(--shadow);width:100%;max-width:400px;padding:20px}
.modal h3{margin-bottom:12px;font-size:15px}
.modal .field{margin-bottom:10px}
.modal .field label{display:block;font-size:12px;color:var(--ink2);margin-bottom:3px}
.modal .field input{width:100%}
.modal .actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
.cardmodal{max-width:780px;padding:0;overflow:hidden}
.cardmodal .banner{width:100%;height:170px;object-fit:cover;display:block}
.cardmodal .inner{padding:18px 22px 22px}
.cardmodal .close{float:right;font-size:16px;padding:2px 9px}
.cardmodal .cid{font:12px ui-monospace,Menlo,monospace;color:var(--muted)}
.cardmodal h2{font-size:18px;margin:2px 0 8px}
.cardmodal .metaline{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:12px}
.cardmodal .tabbar{display:flex;gap:2px;border-bottom:var(--bw) var(--bs) var(--grid);margin:0 -22px;padding:0 22px}
.cardmodal .tabbar button{border:none;background:none;border-radius:0;padding:8px 12px;color:var(--muted);border-bottom:2px solid transparent}
.cardmodal .tabbar button.on{color:var(--ink);border-bottom-color:var(--acc);font-weight:600}
.cardmodal .pane{padding-top:14px;min-height:180px}
.cardmodal h4{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:16px 0 7px;display:flex;align-items:center;gap:8px}
.cardmodal h4:first-child{margin-top:0}
.cardmodal h4 .h-act{margin-left:auto;display:flex;gap:6px}
.cardmodal h4 button{font-size:11px;padding:1px 8px}
.desc{font-size:13.5px}
.desc p{margin:6px 0}
.desc code{font:12px ui-monospace,Menlo,monospace;background:var(--page);border:var(--bw) var(--bs) var(--grid);border-radius:4px;padding:0 4px}
.desc pre{background:var(--page);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rk);padding:10px;overflow-x:auto;font:12px ui-monospace,Menlo,monospace;margin:8px 0}
.desc ul{padding-left:20px;margin:5px 0}
.cl{margin-bottom:8px}
.cl .clhead{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--ink2);margin-bottom:5px}
.cl .clbar{flex:1;height:6px;border-radius:3px;background:var(--grid);overflow:hidden;max-width:220px}
.cl .clbar i{display:block;height:100%;background:var(--acc)}
.cl .item{display:flex;gap:9px;align-items:flex-start;padding:4px 2px;border-radius:var(--rk);cursor:pointer;font-size:13.5px}
.cl .item:hover{background:var(--page)}
.cl .box{width:16px;height:16px;flex:none;border:var(--bw) solid var(--baseline);border-radius:4px;margin-top:1px;display:grid;place-items:center;color:var(--acc-ink)}
.cl .item.done .box{background:var(--acc);border-color:var(--acc)}
.cl .item.done .txt{color:var(--muted);text-decoration:line-through}
.att{display:flex;align-items:center;gap:10px;padding:6px 8px;border:var(--bw) var(--bs) var(--grid);border-radius:var(--rk);margin:5px 0;background:var(--page);font-size:13px}
.att .lbl{font-weight:550}
.att .host{color:var(--muted);font-size:11px}
.att a{margin-left:auto;color:var(--acc);text-decoration:none;font-size:12px;white-space:nowrap}
.att button{font-size:11px;padding:1px 7px}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-top:8px}
.gallery .shot{position:relative;border:var(--bw) var(--bs) var(--grid);border-radius:var(--rk);overflow:hidden;background:var(--page)}
.gallery img{width:100%;height:96px;object-fit:cover;display:block;cursor:zoom-in}
.gallery .setcov{position:absolute;right:5px;bottom:5px;font-size:10px;padding:1px 7px;opacity:0;transition:opacity .12s}
.gallery .shot:hover .setcov{opacity:1}
.kv{font-size:12px;color:var(--ink2);border-top:var(--bw) var(--bs) var(--grid);margin-top:16px;padding-top:10px;display:flex;flex-wrap:wrap;gap:4px 18px}
.kv b{color:var(--muted);font-weight:500}
.chat{display:flex;flex-direction:column;gap:10px}
.msg{background:var(--page);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);padding:8px 12px;max-width:85%}
.msg .who{font-size:11px;color:var(--muted);margin-bottom:2px}
.msg .who b{color:var(--ink2)}
.composer{display:flex;gap:8px;margin-top:14px}
.composer input{flex:1}
.actlist{font-size:13px}
.actlist .a{display:flex;gap:10px;padding:5px 0;border-bottom:1px dashed var(--grid)}
.actlist .when{font:11px ui-monospace,Menlo,monospace;color:var(--muted);white-space:nowrap;padding-top:2px}
.actlist .who{font-weight:600}
.settings .stiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin:10px 0 18px}
.stile{border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);padding:10px;cursor:pointer;background:var(--surface)}
.stile.on{outline:2px solid var(--acc)}
.stile .prev{height:52px;border-radius:6px;margin-bottom:8px;display:flex;gap:3px;padding:7px;align-items:flex-end}
.stile .prev i{flex:1;border-radius:3px}
.stile b{font-size:13px}
.stile .blurb{font-size:11px;color:var(--muted)}
.accents{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 16px}
.accpill{display:inline-flex;align-items:center;gap:6px;border:var(--bw) var(--bs) var(--grid);border-radius:999px;padding:3px 11px;cursor:pointer;font-size:12px;background:var(--surface)}
.accpill.on{outline:2px solid var(--acc)}
.accpill .sw{width:12px;height:12px;border-radius:50%}
.modesel{display:flex;gap:8px;margin:8px 0 18px}
.accpill input[type=color]{width:18px;height:18px;padding:0;border:none;background:none;cursor:pointer}
button.danger{background:var(--st-blocked);color:#fff;border-color:transparent}
.mrow{display:flex;align-items:center;gap:9px;padding:5px 8px;border-radius:var(--rk);font-size:13px}
.mrow:hover{background:var(--surface)}
.mrow .who{color:var(--muted);font-size:11px}
.mrow button{margin-left:auto;font-size:11px;padding:1px 8px}
.mkids{margin-left:16px;border-left:1px dashed var(--grid);padding-left:8px}
@media (max-width: 760px){
  #burger{display:inline-flex}
  header.top{gap:10px;padding:10px 12px;flex-wrap:wrap}
  header.top .strip,header.top #hstrip{display:none}
  .meter .track{width:80px}
  aside{position:fixed;left:0;top:0;bottom:0;z-index:18;transform:translateX(-105%);transition:transform .16s ease;background:var(--page);box-shadow:8px 0 30px rgba(0,0,0,.25);width:min(300px,86vw)}
  aside.open{transform:none}
  .phead{padding:10px 12px;gap:8px}
  .tabs{margin-left:0;width:100%}
  .view{padding:10px 12px}
  .cols{scroll-snap-type:x mandatory;overflow-x:auto;margin:0 -12px;padding:0 12px}
  .col{width:84vw;min-width:84vw;scroll-snap-align:start}
  .overlay{padding:0;align-items:stretch}
  .modal{max-width:100%}
  .cardmodal{max-width:100%;border-radius:0;min-height:100vh}
  .settings .stiles{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}
}
`;

const JS = `
const ORDER=['wishlist','todo','blocked','doing','done','archive'];
const THEMES=window.__THEMES__;
const $=(s,el)=>(el||document).querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct=p=>p==null?'·':Math.round(p*100)+'%';
const IC={check:'<svg class="ic" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="3"/><path d="M5 8.2l2.2 2.2L11.5 6"/></svg>',
  chat:'<svg class="ic" viewBox="0 0 16 16"><path d="M2.5 3.5h11v7h-6l-3 3v-3h-2z"/></svg>',
  clip:'<svg class="ic" viewBox="0 0 16 16"><path d="M12.5 7.5l-4.6 4.6a3 3 0 0 1-4.2-4.2L9 2.6a2 2 0 0 1 2.9 2.9L7 10.4a1 1 0 0 1-1.5-1.5l4.2-4.2"/></svg>',
  gear:'<svg class="ic" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.4"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4"/></svg>',
  tick:'<svg class="ic" style="stroke-width:2.6" viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-6.5"/></svg>',
  open:'<svg class="ic" viewBox="0 0 16 16"><path d="M6.5 3.5h-3v9h9v-3M9.5 2.5h4v4M13 3L7.5 8.5"/></svg>'};
let TOKEN=localStorage.getItem('bf_token')||'';
const PUB=window.__PUB__||null;
let RO=!!PUB;
const cardApi=cid=>PUB?'/api/public/'+PUB+'/cards/'+cid:'/api/projects/'+SEL+'/cards/'+cid;
let THEME={style:'reef',accent:'reef',mode:'system'};
let ORG=null,SEL=null,VIEW='board',BOARD=null,timer=null,MODAL=null;
const mq=matchMedia('(prefers-color-scheme: dark)');
mq.addEventListener('change',()=>applyTheme(THEME));
function yiqInk(hex){
  const n=parseInt(hex.slice(1),16);
  const y=((n>>16&255)*299+(n>>8&255)*587+(n&255)*114)/1000;
  return y>=140?'#141414':'#ffffff';
}
function applyTheme(t){
  THEME=t;
  const st=THEMES.find(s=>s.id===t.style)||THEMES[0];
  const mode=t.mode==='system'?(mq.matches?'dark':'light'):t.mode;
  const p=st[mode];
  let a;
  if(t.accent==='custom'&&t.custom)a={acc:t.custom,accInk:yiqInk(t.custom)};
  else{const acc=st.accents.find(x=>x.id===t.accent)||st.accents[0];a=acc[mode]}
  const R=document.documentElement.style;
  const set=(k,v)=>R.setProperty(k,v);
  set('--page',p.page);set('--surface',p.surface);set('--ink',p.ink);set('--ink2',p.ink2);
  set('--muted',p.muted);set('--grid',p.grid);set('--baseline',p.baseline);set('--ring',p.ring);
  set('--st-wishlist',p.stWishlist);set('--st-todo',p.stTodo);set('--st-blocked',p.stBlocked);
  set('--st-doing',p.stDoing);set('--st-done',p.stDone);set('--st-archive',p.stArchive);
  set('--acc',a.acc);set('--acc-ink',a.accInk);
  set('--rc',st.radiusCard);set('--rk',st.radiusCtl);set('--bw',st.borderW);set('--bs',st.borderStyle||'solid');
  set('--shadow',mode==='dark'?st.shadowDark:st.shadowLight);set('--font',st.font);
  document.documentElement.style.colorScheme=mode;
}
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
  const inline=t=>t.replace(/\`([^\`]+)\`/g,'<code>$1</code>').replace(/\\*\\*([^*]+)\\*\\*/g,'<b>$1</b>').replace(/\\*([^*]+)\\*/g,'<i>$1</i>');
  for(const l of lines){
    if(l.startsWith('\`\`\`')){flush();out.push(fence?'</pre>':'<pre>');fence=!fence;continue}
    if(fence){out.push(l);continue}
    const h=l.match(/^(#{1,4}) (.*)/);if(h){flush();out.push('<h4>'+inline(h[2])+'</h4>');continue}
    const li=l.match(/^- (.*)/);if(li){if(!list){out.push('<ul>');list=1}out.push('<li>'+inline(li[1])+'</li>');continue}
    flush();if(l.trim()!=='')out.push('<p>'+inline(l)+'</p>');
  }
  flush();if(fence)out.push('</pre>');return out.join('\\n');
}
// ---- generic modal + forms (replaces prompt()) ----
function closeOverlay(){const o=$('.overlay');if(o)o.remove();MODAL=null}
function overlay(html,cls){
  closeOverlay();
  const o=document.createElement('div');o.className='overlay';
  o.innerHTML='<div class="modal '+(cls||'')+'" role="dialog" aria-modal="true">'+html+'</div>';
  o.addEventListener('mousedown',e=>{if(e.target===o)closeOverlay()});
  document.body.appendChild(o);
  return o.firstElementChild;
}
function formModal(title,fields,submitLabel,onSubmit){
  const m=overlay('<h3>'+esc(title)+'</h3><form>'+fields.map(f=>
    '<div class="field"><label>'+esc(f.label)+'</label><input name="'+f.name+'" placeholder="'+esc(f.placeholder||'')+'" '+(f.required?'required':'')+'></div>').join('')
    +'<div class="err"></div><div class="actions"><button type="button" class="ghost" data-x>cancel</button><button class="primary">'+esc(submitLabel)+'</button></div></form>');
  $('form',m).onsubmit=async e=>{e.preventDefault();
    const data={};for(const f of fields)data[f.name]=$('[name="'+f.name+'"]',m).value.trim();
    try{await onSubmit(data);closeOverlay()}catch(err){$('.err',m).textContent=err.message}};
  $('[data-x]',m).onclick=closeOverlay;
  const first=$('input',m);if(first)first.focus();
}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeOverlay()});
function confirmModal(title,message,confirmLabel,onConfirm){
  const m=overlay('<h3>'+esc(title)+'</h3><p style="font-size:13px;color:var(--ink2);line-height:1.55">'+message+'</p>'
    +'<div class="err"></div><div class="actions"><button type="button" class="ghost" data-x>cancel</button><button class="danger" data-go>'+esc(confirmLabel)+'</button></div>');
  $('[data-x]',m).onclick=closeOverlay;
  $('[data-go]',m).onclick=async()=>{
    const b=$('[data-go]',m);b.disabled=true;b.textContent='working…';
    try{await onConfirm();closeOverlay()}catch(err){$('.err',m).textContent=err.message;b.disabled=false;b.textContent=confirmLabel}
  };
}
// ---- boot ----
function gate(kind,extra){
  document.body.innerHTML='<div class="gate" id="gate"></div>';
  const g=$('#gate');
  if(kind==='setup'){
    g.innerHTML='<h2>Set up botflow manager</h2><p>Name your company to initialize this deployment. You will get the admin token exactly once.</p>'
      +'<form id="f" style="flex-direction:column"><input id="name" placeholder="company name" required style="margin-bottom:8px">'
      +'<input id="skey" placeholder="setup key (only if this deployment configured one)" style="margin-bottom:8px">'
      +'<button class="primary">Initialize</button></form><div class="err" id="err"></div>';
    $('#f').onsubmit=async e=>{e.preventDefault();
      try{const r=await api('/api/setup',{method:'POST',body:JSON.stringify({name:$('#name').value,setupKey:$('#skey').value||undefined})});
        g.innerHTML='<h2>Admin token</h2><p class="warn">Copy it now. It is never shown again.</p><div class="tokenbox">'+esc(r.token)+'</div>'
          +'<button class="primary" id="go">I saved it, continue</button>';
        $('#go').onclick=()=>{TOKEN=r.token;localStorage.setItem('bf_token',TOKEN);start()};
      }catch(err){$('#err').textContent=err.message}};
  }else{
    g.innerHTML='<h2>botflow manager</h2>'+(extra?'<p class="err">'+esc(extra)+'</p>':'')
      +'<form id="f"><input id="tok" placeholder="bfa_admin token" autocomplete="off" required><button class="primary">admin login →</button></form>'
      +'<div id="gateshares"></div>';
    $('#f').onsubmit=e=>{e.preventDefault();TOKEN=$('#tok').value.trim();localStorage.setItem('bf_token',TOKEN);start()};
    api('/api/public/gate').then(r=>{
      if(r.shares&&r.shares.length)$('#gateshares').outerHTML='<div class="gateshares"><span class="lbl">live boards</span>'
        +r.shares.map(s=>'<a href="/s/'+esc(s.token)+'">'+esc(s.name)+'</a>').join('')+'</div>';
    }).catch(()=>{});
  }
  g.insertAdjacentHTML('beforeend','<div class="gatefoot">Git-native kanban for AI agents. Agents work the board, you watch everything.<br>'
    +'Free to self-host, one click on Cloudflare. <a href="/about">learn more</a> · <a href="https://github.com/kodareef5/botflow" target="_blank" rel="noopener">GitHub</a></div>');
}
async function start(){
  clearInterval(timer);
  try{applyTheme(await api('/api/theme'))}catch{}
  let org;
  try{org=await api('/api/org')}catch(err){
    if(err.status===401)return gate('token',TOKEN?'token rejected':null);
    return gate('token',err.message);
  }
  if(org.uninitialized)return gate('setup');
  ORG=org;
  if(SEL&&SEL!=='::settings'&&!findAny(SEL))SEL=null;
  if(!SEL){const first=firstProject(ORG);SEL=first?first.id:null}
  layout();
}
function firstProject(org){for(const s of org.spaces)if(s.projects.length)return s.projects[0];return null}
function findProject(id,nodes){for(const n of nodes||[]){if(n.id===id)return n;const d=findProject(id,n.children);if(d)return d}return null}
function findAny(id){for(const s of ORG.spaces){const p=findProject(id,s.projects);if(p)return p}return null}
function spaceOf(pid){for(const s of ORG.spaces)if(findProject(pid,s.projects))return s.id;return null}
async function reloadOrg(){ORG=await api('/api/org');renderSide();renderHeader()}
function renderHeader(){
  const agg=ORG.aggregate;
  $('#hmeter').innerHTML='<div class="track"><div class="fill" style="width:'+Math.round((agg.progress||0)*100)+'%"></div></div><b>'+pct(agg.progress)+'</b>';
  $('#hstrip').outerHTML='<span id="hstrip">'+strip(agg.distribution)+'</span>';
}
function layout(){
  document.body.innerHTML=
    '<header class="top"><button id="burger" class="ghost" aria-label="menu">☰</button><h1>'+esc(ORG.name)+' <span class="sub">botflow manager</span></h1>'
    +'<div class="meter" id="hmeter"></div><span id="hstrip"></span>'
    +'<span class="spacer"></span><button id="setbtn" class="ghost" title="settings">'+IC.gear+' settings</button><button id="logout" class="ghost">log out</button></header>'
    +'<div class="app"><aside id="side"></aside><section class="content" id="main"></section></div>';
  $('#logout').onclick=()=>{localStorage.removeItem('bf_token');TOKEN='';gate('token')};
  $('#setbtn').onclick=()=>{SEL='::settings';renderSide();renderMain()};
  $('#burger').onclick=()=>$('#side').classList.toggle('open');
  renderHeader();renderSide();renderMain();
  timer=setInterval(()=>{if(VIEW==='board'&&SEL&&SEL!=='::settings'&&!MODAL)refreshBoard(true)},3000);
}
function projRow(n){
  const a=n.aggregate;
  return '<div class="row '+(n.id===SEL?'sel':'')+'" data-proj="'+n.id+'">'
    +esc(n.name)+'<button class="add" data-addsub="'+n.id+'" title="add sub-project">+</button>'
    +'<span class="pct">'+pct(a.progress)+'</span>'+statechip(a.state)+'</div>'
    +(n.children.length?'<div class="kids">'+n.children.map(projRow).join('')+'</div>':'');
}
function renderSide(){
  $('#side').innerHTML=ORG.spaces.map(s=>
    '<div class="space"><h2>'+esc(s.name)+' <span class="pct" style="margin-left:6px">'+pct(s.aggregate.progress)+'</span>'
    +'<button data-addproj="'+s.id+'">+ project</button></h2>'
    +(s.projects.length?s.projects.map(projRow).join(''):'<div class="empty">no projects</div>')
    +'</div>').join('')
    +'<h2>company <button id="addspace">+ space</button></h2>'
    +'<div class="sidefoot"><div class="row '+(SEL==='::settings'?'sel':'')+'" id="setrow">'+IC.gear+' settings</div></div>';
  $('#side').onclick=async e=>{
    if(e.target.closest('#setrow')){SEL='::settings';renderSide();renderMain();return}
    const add=e.target.closest('[data-addproj]');
    if(add){formModal('New project',[{name:'name',label:'project name',required:true}],'create',async d=>{
      await api('/api/projects',{method:'POST',body:JSON.stringify({space:add.dataset.addproj,name:d.name})});await reloadOrg()});return}
    const sub=e.target.closest('[data-addsub]');
    if(sub){formModal('New sub-project',[{name:'name',label:'sub-project name',required:true}],'create',async d=>{
      await api('/api/projects',{method:'POST',body:JSON.stringify({parent:sub.dataset.addsub,name:d.name})});await reloadOrg();
      if(SEL===sub.dataset.addsub)refreshBoard()});e.stopPropagation();return}
    const row=e.target.closest('[data-proj]');
    if(row){SEL=row.dataset.proj;VIEW='board';BOARD=null;renderSide();renderMain();$('#side').classList.remove('open')}
  };
  const sp=$('#addspace');if(sp)sp.onclick=()=>formModal('New space',[{name:'name',label:'space name',required:true}],'create',async d=>{
    await api('/api/spaces',{method:'POST',body:JSON.stringify({name:d.name})});await reloadOrg()});
}
function renderMain(){
  const main=$('#main');
  if(SEL==='::settings')return renderSettings(main);
  const p=SEL?findAny(SEL):null;
  if(!p){main.innerHTML='<div class="view"><div class="empty">Create a space and a project to begin. Agents connect with scoped keys via the REST API or <code>botflow push</code>.</div></div>';return}
  main.innerHTML='<div class="phead"><h2>'+esc(p.name)+'</h2><span class="pct" id="pinfo"></span>'
    +'<div class="tabs"><button data-tab="board" class="'+(VIEW==='board'?'on':'')+'">board</button>'
    +'<button data-tab="activity" class="'+(VIEW==='activity'?'on':'')+'">activity</button>'
    +'<button data-tab="keys" class="'+(VIEW==='keys'?'on':'')+'">keys</button>'
    +'<button data-tab="sharing" class="'+(VIEW==='sharing'?'on':'')+'">sharing</button></div></div>'
    +'<div class="view" id="view">loading…</div>';
  main.querySelector('.tabs').onclick=e=>{const b=e.target.closest('[data-tab]');if(b){VIEW=b.dataset.tab;renderMain()}};
  if(VIEW==='board')refreshBoard();else if(VIEW==='activity')refreshActivity();else if(VIEW==='sharing')refreshSharing();else refreshKeys();
}
function badge(ic,txt,cls){return '<span class="'+(cls||'')+'">'+ic+(txt!==undefined?' '+txt:'')+'</span>'}
function cardHtml(b,c){
  const ready=new Set(b.ready||[]);
  const badges=[];
  if(c.checklist)badges.push(badge(IC.check,c.checklist.done+'/'+c.checklist.total,c.checklist.done===c.checklist.total?'ok':''));
  if(c.comments)badges.push(badge(IC.chat,c.comments));
  if(c.attachments)badges.push(badge(IC.clip,c.attachments));
  if(c.assignee)badges.push('<span>@'+esc(c.assignee)+'</span>');
  if(c.priority)badges.push('<span class="'+(c.priority==='p0'?'p0':c.priority==='p1'?'p1':'')+'">'+c.priority+'</span>');
  for(const l of c.labels||[])badges.push('<span>#'+esc(l)+'</span>');
  if(c.blocked)badges.push('<span class="blk" title="'+esc(c.blocked)+'">⛔ blocked</span>');
  if((c.deps||[]).length)badges.push('<span>deps→'+c.deps.map(esc).join(',')+'</span>');
  if(ready.has(c.id))badges.push('<span class="ready bare">▶ ready</span>');
  const board=c.type==='board';
  return '<div class="card '+(c.blocked?'blocked':'')+'" data-card="'+esc(c.id)+'">'
    +(c.cover?'<img class="art" src="'+esc(c.cover)+'" alt="" loading="lazy">':'')
    +'<div class="inner"><div class="cid">'+esc(c.id)+'</div><div class="t">'+esc(c.title)+'</div>'
    +'<div class="badges">'+badges.join('')+'</div>'
    +(board?'<div class="subboard"><button data-goto="'+esc(c.child??'')+'" '+(c.child==null||RO?'disabled':'')+'>'+IC.open+' board</button>'
      +statechip(c.state)
      +(c.childProgress!=null?'<div class="mini" title="'+pct(c.childProgress)+'"><i style="width:'+Math.round((c.childProgress||0)*100)+'%"></i></div>':'')
      +'</div>':'')
    +'</div></div>';
}
function colsHtml(b){
  return '<div class="cols" style="margin-top:12px">'+b.lanes.map(lane=>{
    const n=lane.cards.length;
    const wip=lane.wip!=null?'<span class="'+(n>lane.wip?'wipbad':'n')+'">'+n+'/'+lane.wip+'</span>':'<span class="n">'+n+'</span>';
    let body='';
    if(lane.substates.length){
      for(const sub of lane.substates){
        const cs=lane.cards.filter(c=>c.substate===sub||(sub===lane.substates[0]&&c.substate==null));
        if(cs.length)body+='<div class="sub-h">· '+esc(sub)+'</div>'+cs.map(c=>cardHtml(b,c)).join('');
      }
    }else body=lane.cards.map(c=>cardHtml(b,c)).join('');
    return '<section class="col"><h3>'+esc(lane.name)+' '+wip+'</h3>'+(body||'<div class="empty">·</div>')+'</section>';
  }).join('')+'</div>';
}
function boardClicks(e){
  const go=e.target.closest('[data-goto]');
  if(go&&!go.disabled){SEL=go.dataset.goto;VIEW='board';BOARD=null;renderSide();renderMain();e.stopPropagation();return}
  const el=e.target.closest('[data-card]');
  if(el)openCard(el.dataset.card);
}
async function refreshBoard(quiet){
  let b;try{b=await api('/api/projects/'+SEL+'/board')}catch(err){if(!quiet)$('#view').innerHTML='<div class="err">'+esc(err.message)+'</div>';return}
  if(quiet&&JSON.stringify(b)===JSON.stringify(BOARD))return;
  BOARD=b;
  const pi=$('#pinfo');if(pi)pi.textContent=b.cards+' cards · '+pct(b.progress);
  const errs=(b.findings||[]).filter(f=>f.severity==='error').length;
  const v=$('#view');if(!v)return;
  v.innerHTML=chips(b.distribution)+(errs?'<div class="err">'+errs+' lint error(s)</div>':'')+colsHtml(b);
  v.onclick=boardClicks;
}
// ---- public (shared link) mode: read-only, no org chrome ----
async function publicStart(){
  try{applyTheme(await api('/api/theme'))}catch{}
  let b;
  try{b=await api('/api/public/'+PUB+'/board')}catch(err){
    document.body.innerHTML='<div class="gate"><h2>'+esc(err.message)+'</h2>'
      +'<div class="gatefoot">Git-native kanban for AI agents. <a href="/about">learn more</a> · <a href="https://github.com/kodareef5/botflow" target="_blank" rel="noopener">GitHub</a></div></div>';
    return;
  }
  renderPublic(b);
  setInterval(async()=>{
    if(MODAL)return;
    try{const nb=await api('/api/public/'+PUB+'/board');if(JSON.stringify(nb)!==JSON.stringify(BOARD))renderPublic(nb)}catch{}
  },4000);
}
function renderPublic(b){
  BOARD=b;
  document.title=b.name+' · botflow';
  document.body.innerHTML='<header class="top"><h1>'+esc(b.name)+' <span class="sub">shared board · read only</span></h1>'
    +'<div class="meter"><div class="track"><div class="fill" style="width:'+Math.round((b.progress||0)*100)+'%"></div></div><b>'+pct(b.progress)+'</b></div>'
    +'<span id="hstrip">'+strip(b.distribution)+'</span><span class="spacer"></span></header>'
    +'<div class="view" id="view" style="flex:1;overflow:auto">'+chips(b.distribution)+colsHtml(b)+'</div>'
    +'<div class="pubfoot">shared with botflow: git-native kanban for AI agents. <a href="/about">learn more</a></div>'
    +'<div id="drawer"></div>';
  $('#view').onclick=boardClicks;
}
// ---- the card modal ----
async function openCard(cid,tab){
  let c;try{c=await api(cardApi(cid))}catch(err){return}
  MODAL=cid;
  const t=tab||'card';
  const m=overlay(cardModalHtml(c,t),'cardmodal');
  wireCardModal(m,c,t);
}
function cardModalHtml(c,tab){
  const p=c.parsed||{};
  const meta=[statechip(c.state),'<span class="cid">'+esc(c.position)+'</span>'];
  if(c.assignee)meta.push('<span class="badges"><span>@'+esc(c.assignee)+'</span></span>');
  if(c.priority)meta.push('<span class="badges"><span class="'+(c.priority==='p0'?'p0':'')+'">'+c.priority+'</span></span>');
  for(const l of c.labels||[])meta.push('<span class="badges"><span>#'+esc(l)+'</span></span>');
  if(c.blocked)meta.push('<span class="badges"><span class="blk">⛔ '+esc(c.blocked)+'</span></span>');
  const tabs=[['card','card'],['chat','chat '+((p.comments||[]).length||'')],['activity','activity']];
  return (c.cover?'<img class="banner" src="'+esc(c.cover)+'" alt="">':'')
    +'<div class="inner"><button class="close ghost" data-x>✕</button>'
    +'<div class="cid">'+esc(c.id)+'</div><h2>'+esc(c.title)+'</h2>'
    +'<div class="metaline">'+meta.join(' ')+'</div>'
    +'<div class="tabbar">'+tabs.map(([id,lbl])=>'<button data-ctab="'+id+'" class="'+(id===tab?'on':'')+'">'+lbl+'</button>').join('')+'</div>'
    +'<div class="pane">'+(tab==='card'?paneCard(c):tab==='chat'?paneChat(c):paneActivity(c))+'</div></div>';
}
function paneCard(c){
  const p=c.parsed||{};
  let out='';
  if(c.type==='board'){
    out+='<h4>project board</h4><div class="subboard" style="max-width:340px"><button data-goto2="'+esc(c.child??'')+'" '+(c.child==null||RO?'disabled':'')+'>'+IC.open+' open board</button>'+statechip(c.state)+'</div>';
  }
  out+='<h4>description</h4><div class="desc">'+(p.description?md(p.description):'<span class="empty">no description</span>')+'</div>';
  for(const cl of p.checklists||[]){
    const done=cl.items.filter(i=>i.checked).length;
    out+='<div class="cl"><h4>'+esc(cl.section)+'</h4><div class="clhead"><span>'+done+'/'+cl.items.length+'</span><div class="clbar"><i style="width:'+Math.round(done/cl.items.length*100)+'%"></i></div></div>'
      +cl.items.map(i=>'<div class="item '+(i.checked?'done':'')+'" '+(RO?'':'data-check="'+i.index+'" data-on="'+i.checked+'"')+' style="'+(RO?'cursor:default':'')+'"><span class="box">'+(i.checked?IC.tick:'')+'</span><span class="txt">'+esc(i.text)+'</span></div>').join('')
      +'</div>';
  }
  const atts=p.attachments||[];
  out+='<h4>attachments'+(RO?'':' <span class="h-act"><button data-attach>+ add link</button></span>')+'</h4>';
  out+=atts.length?atts.map(a=>{
    let host='';try{host=new URL(a.url).hostname}catch{}
    return '<div class="att">'+IC.clip+'<span class="lbl">'+esc(a.label)+'</span><span class="host">'+esc(host)+'</span>'
      +'<a href="'+esc(a.url)+'" target="_blank" rel="noopener">open '+IC.open+'</a>'+(RO?'':'<button class="ghost" data-detach="'+a.index+'" title="remove">✕</button>')+'</div>';
  }).join(''):'<div class="empty">nothing attached</div>';
  const imgs=p.images||[];
  if(imgs.length){
    out+='<h4>gallery'+(RO?'':' <span class="h-act">'+(c.cover?'<button data-cover="none">hide art</button>':'<button data-cover="auto">auto art</button>')+'</span>')+'</h4><div class="gallery">'
      +imgs.map(u=>'<div class="shot"><a href="'+esc(u)+'" target="_blank" rel="noopener"><img src="'+esc(u)+'" alt="" loading="lazy"></a>'+(RO?'':'<button class="setcov primary" data-cover="'+esc(u)+'">☆ cover</button>')+'</div>').join('')+'</div>';
  }
  const kv=[];
  if(c.created)kv.push('<span><b>created</b> '+esc(c.created)+'</span>');
  if(c.updated)kv.push('<span><b>updated</b> '+esc(c.updated)+'</span>');
  if((c.deps||[]).length)kv.push('<span><b>deps</b> '+c.deps.map(esc).join(', ')+'</span>');
  kv.push('<span><b>file</b> '+esc(c.file)+'</span>');
  out+='<div class="kv">'+kv.join('')+'</div>';
  return out;
}
function paneChat(c){
  const list=(c.parsed&&c.parsed.comments)||[];
  return '<div class="chat">'+(list.length?list.map(m=>'<div class="msg"><div class="who"><b>'+esc(m.actor)+'</b> · '+esc(m.when)+'</div>'+esc(m.text)+'</div>').join('')
    :'<div class="empty">no comments yet'+(RO?'':'. talk to your agents here')+'</div>')+'</div>'
    +(RO?'':'<form class="composer"><input placeholder="write a comment…" required><button class="primary">send</button></form>');
}
function paneActivity(c){
  const list=(c.parsed&&c.parsed.log)||[];
  return '<div class="actlist">'+(list.length?list.map(e=>'<div class="a"><span class="when">'+esc(e.when)+'</span><span><span class="who">'+esc(e.actor)+'</span> '+esc(e.text)+'</span></div>').join('')
    :'<div class="empty">no activity</div>')+'</div>';
}
function wireCardModal(m,c,tab){
  $('[data-x]',m).onclick=()=>{closeOverlay();if(!PUB)refreshBoard(true)};
  m.querySelector('.tabbar').onclick=e=>{const b=e.target.closest('[data-ctab]');if(b)openCard(c.id,b.dataset.ctab)};
  m.addEventListener('click',async e=>{
    if(RO)return;
    const go=e.target.closest('[data-goto2]');
    if(go&&!go.disabled){closeOverlay();SEL=go.dataset.goto2;VIEW='board';BOARD=null;renderSide();renderMain();return}
    const chk=e.target.closest('[data-check]');
    if(chk){await api('/api/projects/'+SEL+'/cards/'+c.id+'/check',{method:'POST',body:JSON.stringify({index:Number(chk.dataset.check),checked:chk.dataset.on!=='true'})});openCard(c.id,'card');return}
    const det=e.target.closest('[data-detach]');
    if(det){await api('/api/projects/'+SEL+'/cards/'+c.id+'/detach',{method:'POST',body:JSON.stringify({index:Number(det.dataset.detach)})});openCard(c.id,'card');return}
    const cov=e.target.closest('[data-cover]');
    if(cov){const v=cov.dataset.cover;await api('/api/projects/'+SEL+'/cards/'+c.id+'/edit',{method:'POST',body:JSON.stringify({cover:v==='auto'?null:v})});openCard(c.id,'card');return}
    if(e.target.closest('[data-attach]')){
      formModal('Attach a link',[{name:'url',label:'url (images join the gallery)',required:true},{name:'label',label:'label (optional)'}],'attach',async d=>{
        await api('/api/projects/'+SEL+'/cards/'+c.id+'/attach',{method:'POST',body:JSON.stringify({url:d.url,label:d.label||undefined})});openCard(c.id,'card')});
    }
  });
  const composer=m.querySelector('.composer');
  if(composer)composer.onsubmit=async e=>{e.preventDefault();
    const input=composer.querySelector('input');
    await api('/api/projects/'+SEL+'/cards/'+c.id+'/comment',{method:'POST',body:JSON.stringify({message:input.value})});
    openCard(c.id,'chat')};
}
// ---- activity + keys + settings ----
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
      +' <span style="color:var(--muted);font-size:12px">scoped to this project and everything nested beneath it</span></p>'
      +(keys.length?'<table class="list"><tr><th>label</th><th>id</th><th>created</th><th></th></tr>'
        +keys.map(k=>'<tr'+(k.revoked?' style="opacity:.5"':'')+'><td>'+esc(k.label)+'</td><td class="mono">'+esc(k.id)+'</td><td class="mono">'+esc(k.created.slice(0,10))+'</td>'
          +'<td>'+(k.revoked?'revoked':'<button data-rk="'+esc(k.id)+'">revoke</button>')+'</td></tr>').join('')+'</table>'
        :'<div class="empty">no keys yet</div>');
    $('#mk').onclick=()=>formModal('New agent key',[{name:'label',label:'label (becomes the agent actor name)',required:true}],'mint',async d=>{
      const r=await api('/api/projects/'+SEL+'/keys',{method:'POST',body:JSON.stringify({label:d.label})});
      $('#view').insertAdjacentHTML('afterbegin','<div class="tokenbox">'+esc(r.token)+'</div><p class="warn">Copy this agent key now: it is never shown again.</p>');
    });
    $('#view').addEventListener('click',async e=>{const b=e.target.closest('[data-rk]');if(b){await api('/api/keys/'+b.dataset.rk+'/revoke',{method:'POST'});refreshKeys()}});
  }catch(err){$('#view').innerHTML='<div class="err">'+esc(err.message)+'</div>'}
}
async function refreshSharing(){
  try{
    const shares=await api('/api/projects/'+SEL+'/shares');
    const live=shares.filter(s=>!s.revoked);
    $('#view').innerHTML='<p style="margin-bottom:10px"><button class="primary" id="mksh">+ share link</button>'
      +' <span style="color:var(--muted);font-size:12px">read-only public url for this board. anyone with the link can view.</span></p>'
      +(shares.length?'<table class="list"><tr><th>label</th><th>url</th><th>created</th><th></th></tr>'
        +shares.map(s=>'<tr'+(s.revoked?' style="opacity:.5"':'')+'><td>'+esc(s.label)+'</td>'
          +'<td class="mono">'+(s.revoked?'revoked':'<a href="/s/'+esc(s.token)+'" target="_blank" style="color:var(--acc)">/s/'+esc(s.token.slice(0,10))+'…</a> <button class="ghost" data-copy="'+esc(s.token)+'">copy</button>')+'</td>'
          +'<td class="mono">'+esc(s.created.slice(0,10))+'</td>'
          +'<td><button data-ds="'+esc(s.id)+'">delete</button></td></tr>').join('')+'</table>'
        :'<div class="empty">no share links yet</div>')
      +(live.length?'<p style="color:var(--muted);font-size:12px;margin-top:10px">live links are listed on the login page unless you turn that off in settings.</p>':'');
    $('#mksh').onclick=()=>formModal('New share link',[{name:'label',label:'label (for your own bookkeeping)',required:true}],'create',async d=>{
      const r=await api('/api/projects/'+SEL+'/shares',{method:'POST',body:JSON.stringify({label:d.label})});
      refreshSharing();
      setTimeout(()=>$('#view').insertAdjacentHTML('afterbegin','<div class="tokenbox">'+location.origin+'/s/'+esc(r.token)+'</div>'),150);
    });
    $('#view').addEventListener('click',async e=>{
      const cp=e.target.closest('[data-copy]');
      if(cp){try{await navigator.clipboard.writeText(location.origin+'/s/'+cp.dataset.copy);cp.textContent='copied'}catch{}return}
      const dl=e.target.closest('[data-ds]');
      if(dl){await api('/api/shares/'+dl.dataset.ds,{method:'DELETE'});refreshSharing()}
    });
  }catch(err){$('#view').innerHTML='<div class="err">'+esc(err.message)+'</div>'}
}
function stylePreview(st){
  const mode=THEME.mode==='system'?(mq.matches?'dark':'light'):THEME.mode;
  const p=st[mode],a=(st.accents[0])[mode];
  return '<div class="prev" style="background:'+p.page+';border:1px solid '+p.grid+'">'
    +'<i style="background:'+a.acc+';height:70%"></i><i style="background:'+p.stDoing+';height:45%"></i>'
    +'<i style="background:'+p.stDone+';height:88%"></i><i style="background:'+p.grid+';height:30%"></i></div>';
}
function renderSettings(main){
  const st=THEMES.find(s=>s.id===THEME.style)||THEMES[0];
  main.innerHTML='<div class="phead"><h2>settings</h2></div><div class="view settings">'
    +'<h4 style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">style</h4>'
    +'<div class="stiles">'+THEMES.map(s=>'<div class="stile '+(s.id===THEME.style?'on':'')+'" data-style="'+s.id+'">'+stylePreview(s)+'<b>'+esc(s.name)+'</b><div class="blurb">'+esc(s.blurb)+'</div></div>').join('')+'</div>'
    +'<h4 style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">accent</h4>'
    +'<div class="accents">'+st.accents.map(a=>{const mode=THEME.mode==='system'?(mq.matches?'dark':'light'):THEME.mode;
      return '<span class="accpill '+(a.id===THEME.accent?'on':'')+'" data-accent="'+a.id+'"><span class="sw" style="background:'+a[mode].acc+'"></span>'+esc(a.name)+'</span>'}).join('')
    +'<label class="accpill '+(THEME.accent==='custom'?'on':'')+'" id="custpill"><input type="color" id="custcol" value="'+(THEME.custom||'#7d5bc6')+'">pick your own</label>'
    +'</div>'
    +'<h4 style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">mode</h4>'
    +'<div class="modesel">'+['system','light','dark'].map(mo=>'<button data-mode="'+mo+'" class="'+(mo===THEME.mode?'primary':'')+'">'+mo+'</button>').join('')+'</div>'
    +'<p style="color:var(--muted);font-size:12px">Saved for the whole company. Every operator and share page paints with it.</p>'
    +'<h4 style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:22px">login page</h4>'
    +'<label style="font-size:13px;display:flex;gap:8px;align-items:center"><input type="checkbox" id="gs"> list public board links on the login page</label>'
    +'<h4 style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:22px">company data</h4>'
    +'<div style="display:flex;gap:8px;flex-wrap:wrap"><button id="orgexp">download company export</button>'
    +'<button id="demoload">load the Scoops Empire demo</button></div>'
    +'<p style="color:var(--muted);font-size:12px;margin-top:6px">The export is one JSON with every space, project, board, and card. The demo adds a sample ice cream company as a new space.</p>'
    +'<h4 style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:22px">manage: spaces and projects</h4>'
    +'<div id="mtree" style="max-width:560px"></div>'
    +'<h4 style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:22px">manage: share links</h4>'
    +'<div id="mshares" style="max-width:720px">loading…</div>'
    +'<h4 style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:22px">company activity</h4>'
    +'<div id="maudit" style="max-width:720px">loading…</div>'
    +'<div class="err" id="serr"></div></div>';
  api('/api/org/activity?limit=50').then(list=>{
    const el=$('#maudit');if(!el)return;
    el.innerHTML=list.length?'<table class="list"><tr><th>when</th><th>actor</th><th>action</th><th>detail</th></tr>'
      +list.map(a=>'<tr><td class="mono">'+esc((a.ts||'').replace('T',' ').slice(0,16))+'</td><td>'+esc(a.actor)+'</td><td>'+esc(a.action)+'</td><td>'+esc(a.detail)+'</td></tr>').join('')+'</table>'
      :'<div class="empty">no org activity yet</div>';
  }).catch(()=>{});
  const countTree=n=>1+n.children.reduce((a,c)=>a+countTree(c),0);
  const mrowProj=n=>'<div class="mrow">'+esc(n.name)+'<span class="who">'+esc(n.id)+'</span>'
    +'<button data-delproj="'+esc(n.id)+'" data-name="'+esc(n.name)+'" data-count="'+countTree(n)+'">delete</button></div>'
    +(n.children.length?'<div class="mkids">'+n.children.map(mrowProj).join('')+'</div>':'');
  $('#mtree').innerHTML=ORG.spaces.length?ORG.spaces.map(s=>
    '<div class="mrow" style="font-weight:600">'+esc(s.name)+'<span class="who">'+esc(s.id)+'</span>'
    +'<button data-delspace="'+esc(s.id)+'" data-name="'+esc(s.name)+'" data-count="'+s.projects.reduce((a,p)=>a+countTree(p),0)+'">delete space</button></div>'
    +(s.projects.length?'<div class="mkids">'+s.projects.map(mrowProj).join('')+'</div>':'')).join('')
    :'<div class="empty">no spaces yet</div>';
  api('/api/org/shares').then(list=>{
    const el=$('#mshares');if(!el)return;
    el.innerHTML=list.length?'<table class="list"><tr><th>project</th><th>label</th><th>url</th><th>created</th><th></th></tr>'
      +list.map(s=>'<tr'+(s.revoked?' style="opacity:.5"':'')+'><td>'+esc(s.projectName)+'</td><td>'+esc(s.label)+'</td>'
        +'<td class="mono"><a href="/s/'+esc(s.token)+'" target="_blank" style="color:var(--acc)">/s/'+esc(s.token.slice(0,10))+'…</a></td>'
        +'<td class="mono">'+esc(s.created.slice(0,10))+'</td><td><button data-delsh="'+esc(s.id)+'">delete</button></td></tr>').join('')+'</table>'
      :'<div class="empty">no share links</div>';
  }).catch(()=>{});
  const save=async next=>{
    try{const saved=await api('/api/settings',{method:'POST',body:JSON.stringify(next)});applyTheme(saved);renderSettings(main)}
    catch(err){$('#serr').textContent=err.message}
  };
  api('/api/settings').then(cur=>{const gs=$('#gs');if(gs){gs.checked=cur.gateShares!==false;
    gs.onchange=()=>api('/api/settings',{method:'POST',body:JSON.stringify({...THEME,gateShares:gs.checked})}).catch(err=>{$('#serr').textContent=err.message})}});
  $('#orgexp').onclick=async()=>{
    try{const data=await api('/api/org/export');
      const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='botflow-company-export.json';a.click();URL.revokeObjectURL(a.href);
    }catch(err){$('#serr').textContent=err.message}};
  $('#demoload').onclick=async()=>{
    const b=$('#demoload');b.disabled=true;b.textContent='loading demo…';
    try{await api('/api/demo',{method:'POST'});await start()}catch(err){$('#serr').textContent=err.message;b.disabled=false;b.textContent='load the Scoops Empire demo'}};
  $('#custcol').oninput=e=>save({...THEME,accent:'custom',custom:e.target.value});
  main.querySelector('.settings').onclick=async e=>{
    const dp=e.target.closest('[data-delproj]');
    if(dp){const n=dp.dataset.name,c=Number(dp.dataset.count);
      confirmModal('Delete project',"Permanently deletes '"+esc(n)+"'"+(c>1?' and its '+(c-1)+' nested project(s)':'')
        +': boards, cards, keys, and share links. No undo. Download a company export first if unsure.',
        'delete forever',async()=>{await api('/api/projects/'+dp.dataset.delproj,{method:'DELETE'});await start()});return}
    const dsp=e.target.closest('[data-delspace]');
    if(dsp){const n=dsp.dataset.name,c=Number(dsp.dataset.count);
      confirmModal('Delete space',"Permanently deletes the space '"+esc(n)+"' and all "+c+" project(s) inside it: boards, cards, keys, and share links. No undo. Download a company export first if unsure.",
        'delete forever',async()=>{await api('/api/spaces/'+dsp.dataset.delspace,{method:'DELETE'});await start()});return}
    const dsh=e.target.closest('[data-delsh]');
    if(dsh){await api('/api/shares/'+dsh.dataset.delsh,{method:'DELETE'});renderSettings(main);return}
    if(e.target.closest('#custpill'))return; // the color input handles itself
    const tile=e.target.closest('[data-style]');
    const pill=e.target.closest('[data-accent]');
    const mode=e.target.closest('[data-mode]');
    if(!tile&&!pill&&!mode)return;
    const next={...THEME};
    if(tile){next.style=tile.dataset.style;const ns=THEMES.find(s=>s.id===next.style);
      if(next.accent!=='custom'&&!ns.accents.some(a=>a.id===next.accent))next.accent=ns.accents[0].id}
    if(pill)next.accent=pill.dataset.accent;
    if(mode)next.mode=mode.dataset.mode;
    save(next);
  };
}
applyTheme(THEME);
if(PUB)publicStart();else start();
`;

export function uiHtml(pub: string | null): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>botflow manager</title>
<style>${CSS}</style>
</head>
<body>
<script>window.__THEMES__=${JSON.stringify(STYLES)};window.__PUB__=${JSON.stringify(pub)};</script>
<script>${JS}</script>
</body>
</html>`;
}
