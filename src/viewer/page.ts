// The read-only board page: one self-contained HTML file, zero dependencies.
// Used two ways: `botflow board --html` embeds a data snapshot; `botflow serve`
// serves the same page in live mode, polling /api/data.
//
// Colors follow the validated reference palette (see dogfood card 005's log):
// states in strip order wishlist·todo·blocked·doing·done·archive pass CVD and
// normal-vision adjacency checks in both modes; neutral segments are
// deliberately recessive and always paired with labeled count chips.

import type { Analysis } from '../core/analyze.ts';
import { lintBoard } from '../core/analyze.ts';
import type { Tree } from '../core/load.ts';
import { boardJson, cardJson } from '../cli/render.ts';

export interface ViewerData {
  root: string;
  generated: string;
  boards: Record<string, unknown>;
}

export function viewerData(tree: Tree, analysis: Analysis): ViewerData {
  const boards: Record<string, unknown> = {};
  for (const [key, node] of tree.boards) {
    const ba = analysis.boards.get(key)!;
    const json = boardJson(tree, analysis, key) as Record<string, unknown>;
    // Card bodies power the detail drawer.
    json['lanes'] = node.board.config.lanes.map((lane) => ({
      id: lane.id,
      name: lane.name,
      canonical: lane.canonical,
      substates: lane.substates,
      order: lane.order,
      wip: lane.wip,
      cards: node.board.cards
        .filter((c) => c.laneId === lane.id)
        .map((c) => ({ ...cardJson(c, node, ba), body: c.body })),
    }));
    json['findings'] = lintBoard(node, ba);
    boards[key] = json;
  }
  return { root: '.', generated: new Date().toISOString(), boards };
}

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
body{background:var(--page);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh}
header{position:sticky;top:0;z-index:5;background:var(--page);border-bottom:1px solid var(--grid);padding:14px 20px 12px;display:flex;flex-wrap:wrap;gap:14px 26px;align-items:center}
h1{font-size:17px;font-weight:650;display:flex;gap:10px;align-items:baseline}
h1 .sub{color:var(--muted);font-size:12px;font-weight:400}
select{font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--grid);border-radius:6px;padding:3px 6px}
.meter{display:flex;align-items:center;gap:8px}
.meter .track{width:160px;height:8px;border-radius:4px;background:var(--grid);overflow:hidden}
.meter .fill{height:100%;border-radius:4px;background:var(--progress)}
.meter .num{font-weight:650}
.meter .lbl{color:var(--muted);font-size:12px}
.dist{display:flex;flex-direction:column;gap:6px;min-width:230px}
.strip{display:flex;gap:2px;height:12px;border-radius:4px;overflow:hidden;background:var(--grid)}
.strip i{display:block;height:100%;min-width:8px}
.chips{display:flex;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--ink-2)}
.chips b{font-weight:650;color:var(--ink)}
.chips .z{opacity:.45}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:baseline;border:1px solid var(--ring)}
.lintchips{margin-left:auto;display:flex;gap:8px;font-size:12px}
.lintchips a{color:inherit;text-decoration:none;border:1px solid var(--grid);border-radius:999px;padding:2px 9px;background:var(--surface)}
.lintchips .e{color:var(--st-blocked);font-weight:650}
.lintchips .w{color:var(--p1);font-weight:650}
main{display:flex;gap:12px;padding:16px 20px 40px;overflow-x:auto;align-items:flex-start}
.col{background:var(--surface);border:1px solid var(--grid);border-radius:10px;min-width:270px;width:270px;flex:none;padding:10px}
.col h2{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2);display:flex;gap:6px;align-items:baseline;padding:2px 4px 8px}
.col h2 .n{color:var(--muted);font-weight:400}
.col h2 .wipbad{color:var(--p1);font-weight:650}
.col h2 .canon{color:var(--muted);font-weight:400;text-transform:none}
.sub-h{font-size:11px;color:var(--muted);padding:6px 4px 2px;border-top:1px dashed var(--grid);margin-top:6px}
.card{border:1px solid var(--grid);border-radius:8px;padding:8px 10px;margin:6px 0;background:var(--page);cursor:pointer}
.card:hover{border-color:var(--baseline)}
.card.blocked{border-left:3px solid var(--st-blocked)}
.card .cid{font:11px ui-monospace,Menlo,monospace;color:var(--muted)}
.card .t{font-weight:550;margin:1px 0 4px}
.badges{display:flex;flex-wrap:wrap;gap:5px;font-size:11px;color:var(--ink-2)}
.badges span{border:1px solid var(--grid);border-radius:999px;padding:1px 7px;background:var(--surface)}
.badges .ready{color:var(--ready);font-weight:650}
.badges .p0{color:var(--p0);font-weight:650}
.badges .p1{color:var(--p1);font-weight:650}
.badges .blk{color:var(--st-blocked)}
.subboard{margin-top:7px;display:flex;gap:8px;align-items:center}
.subboard button{font:12px system-ui;border:1px solid var(--grid);background:var(--surface);color:var(--ink);border-radius:6px;padding:2px 8px;cursor:pointer}
.subboard .mini{flex:1;height:6px;border-radius:3px;background:var(--grid);overflow:hidden}
.subboard .mini i{display:block;height:100%;background:var(--progress)}
.statechip{font-size:11px;border-radius:999px;padding:1px 8px;color:#fff}
footer{padding:0 20px 40px;max-width:900px}
footer h3{font-size:13px;margin-bottom:8px;color:var(--ink-2)}
.finding{font:12px ui-monospace,Menlo,monospace;padding:3px 0;color:var(--ink-2)}
.finding b{color:var(--st-blocked)} .finding i{color:var(--p1);font-style:normal}
#drawer{position:fixed;top:0;right:0;bottom:0;width:min(480px,92vw);background:var(--surface);border-left:1px solid var(--grid);box-shadow:-12px 0 30px rgba(0,0,0,.12);padding:20px;overflow-y:auto;display:none;z-index:10}
#drawer.open{display:block}
#drawer .close{float:right;border:none;background:none;font-size:18px;color:var(--muted);cursor:pointer}
#drawer h2{font-size:16px;margin:2px 0 10px}
#drawer table{font-size:12px;border-collapse:collapse;margin:10px 0}
#drawer td{padding:2px 10px 2px 0;vertical-align:top;color:var(--ink-2)}
#drawer td:first-child{color:var(--muted)}
#drawer .body{border-top:1px solid var(--grid);margin-top:12px;padding-top:12px;font-size:13px}
#drawer .body h4{margin:12px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2)}
#drawer .body ul{padding-left:20px;margin:4px 0}
#drawer .body li.done{color:var(--muted);text-decoration:line-through}
#drawer .body code{font:12px ui-monospace,Menlo,monospace;background:var(--page);border:1px solid var(--grid);border-radius:4px;padding:0 4px}
#drawer .body pre{background:var(--page);border:1px solid var(--grid);border-radius:6px;padding:10px;overflow-x:auto;font:12px ui-monospace,Menlo,monospace;margin:6px 0}
.empty{color:var(--muted);font-size:12px;padding:6px 4px}
`;

const CLIENT_JS = `
const ORDER=['wishlist','todo','blocked','doing','done','archive'];
const $=(s,el)=>(el||document).querySelector(s);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let DATA=window.__BOTFLOW__||null,CUR='.',LIVE=window.__LIVE__===true;
function stateColor(s){return 'var(--st-'+s+')'}
function pct(p){return p==null?'·':Math.round(p*100)+'%'}
function md(src){
  const lines=esc(src).split('\\n');let out=[],list=null,fence=false;
  const flush=()=>{if(list){out.push('</ul>');list=null}};
  for(const raw of lines){
    if(raw.startsWith('\`\`\`')){flush();out.push(fence?'</pre>':'<pre>');fence=!fence;continue}
    if(fence){out.push(raw);continue}
    let l=raw;
    const inline=t=>t.replace(/\`([^\`]+)\`/g,'<code>$1</code>').replace(/\\*\\*([^*]+)\\*\\*/g,'<b>$1</b>');
    const h=l.match(/^(#{1,4}) (.*)/);
    if(h){flush();out.push('<h4>'+inline(h[2])+'</h4>');continue}
    const ck=l.match(/^- \\[([ xX])\\] (.*)/);
    if(ck){if(!list){out.push('<ul>');list=1}out.push('<li class="'+(ck[1]!==' '?'done':'')+'">'+inline(ck[2])+'</li>');continue}
    const li=l.match(/^- (.*)/);
    if(li){if(!list){out.push('<ul>');list=1}out.push('<li>'+inline(li[1])+'</li>');continue}
    flush();
    if(l.trim()!=='')out.push('<p>'+inline(l)+'</p>');
  }
  flush();if(fence)out.push('</pre>');
  return out.join('\\n')}
function badge(c){
  const b=[];
  if(c.assignee)b.push('<span>@'+esc(c.assignee)+'</span>');
  if(c.priority)b.push('<span class="'+(c.priority==='p0'?'p0':c.priority==='p1'?'p1':'')+'">'+c.priority+'</span>');
  for(const l of c.labels||[])b.push('<span>#'+esc(l)+'</span>');
  if(c.blocked)b.push('<span class="blk" title="'+esc(c.blocked)+'">⛔ blocked</span>');
  if((c.deps||[]).length)b.push('<span>deps→'+c.deps.map(esc).join(',')+'</span>');
  if(READY.has(c.id))b.push('<span class="ready">▶ ready</span>');
  return b.join('')}
let READY=new Set();
function cardHtml(c){
  const board=c.type==='board';
  const child=board&&c.child!=null?DATA.boards[c.child]:null;
  return '<div class="card '+(c.blocked?'blocked':'')+'" data-card="'+esc(c.id)+'">'
    +'<div class="cid">'+esc(c.id)+'</div><div class="t">'+esc(c.title)+'</div>'
    +'<div class="badges">'+badge(c)+'</div>'
    +(board?'<div class="subboard"><button data-goto="'+esc(c.child??'')+'" '+(c.child==null?'disabled':'')+'>⇒ '+esc(c.child??c.board??'?')+'</button>'
      +'<span class="statechip" style="background:'+stateColor(c.state)+'">'+c.state+'</span>'
      +(child?'<div class="mini" title="child progress '+pct(child.progress)+'"><i style="width:'+Math.round((child.progress||0)*100)+'%"></i></div>':'')
      +'</div>':'')
    +'</div>'}
function render(){
  const b=DATA.boards[CUR];if(!b){CUR='.';return render()}
  READY=new Set(b.ready||[]);
  const keys=Object.keys(DATA.boards);
  $('#title').textContent=b.name;
  $('#sub').textContent=b.cards+' cards';
  const sel=$('#switch');
  sel.innerHTML=keys.map(k=>'<option value="'+esc(k)+'" '+(k===CUR?'selected':'')+'>'+esc(k==='.'?b.name+' (root)':k)+'</option>').join('');
  sel.style.display=keys.length>1?'':'none';
  $('#pfill').style.width=Math.round((b.progress||0)*100)+'%';
  $('#pnum').textContent=pct(b.progress);
  const total=ORDER.reduce((n,s)=>n+(b.distribution[s]||0),0)||1;
  $('#strip').innerHTML=ORDER.map(s=>{const n=b.distribution[s]||0;return n?'<i style="flex:'+n+' 1 0;background:'+stateColor(s)+'" title="'+s+': '+n+'"></i>':''}).join('');
  $('#chips').innerHTML=ORDER.map(s=>{const n=b.distribution[s]||0;return '<span class="'+(n?'':'z')+'"><span class="dot" style="background:'+stateColor(s)+'"></span>'+s+' <b>'+n+'</b></span>'}).join('');
  const errs=(b.findings||[]).filter(f=>f.severity==='error').length;
  const warns=(b.findings||[]).filter(f=>f.severity==='warning').length;
  $('#lint').innerHTML=(errs?'<a href="#findings"><span class="e">'+errs+' error'+(errs>1?'s':'')+'</span></a>':'')
    +(warns?'<a href="#findings"><span class="w">'+warns+' warning'+(warns>1?'s':'')+'</span></a>':'');
  $('main').innerHTML=b.lanes.map(lane=>{
    const n=lane.cards.length;
    const wip=lane.wip!=null?'<span class="'+(n>lane.wip?'wipbad':'n')+'">'+n+'/'+lane.wip+(n>lane.wip?' WIP!':'')+'</span>':'<span class="n">'+n+'</span>';
    const canon=lane.canonical!==lane.id?'<span class="canon">→'+lane.canonical+'</span>':'';
    let body='';
    if(lane.substates.length){
      for(const sub of lane.substates){
        const cs=lane.cards.filter(c=>c.substate===sub||(sub===lane.substates[0]&&c.substate==null));
        if(cs.length)body+='<div class="sub-h">· '+esc(sub)+'</div>'+cs.map(cardHtml).join('');
      }
    }else body=lane.cards.map(cardHtml).join('');
    if(!body)body='<div class="empty">·</div>';
    return '<section class="col"><h2>'+esc(lane.name)+' '+canon+' '+wip+'</h2>'+body+'</section>'
  }).join('');
  $('#findings').innerHTML=(b.findings||[]).length
    ?'<h3>findings: '+CUR+'</h3>'+(b.findings||[]).map(f=>'<div class="finding">'+(f.severity==='error'?'<b>error</b>':f.severity==='warning'?'<i>warning</i>':'info')
      +' '+esc(f.rule)+' <b style="color:var(--ink)">'+esc(f.ref)+'</b> · '+esc(f.message)+'</div>').join('')
    :'';
}
function openDrawer(c){
  const d=$('#drawer');
  const rows=[['position',c.position],['state',c.state],['assignee',c.assignee],['priority',c.priority],
    ['labels',(c.labels||[]).join(', ')],['deps',(c.deps||[]).join(', ')],['blocked',c.blocked],
    ['created',c.created],['updated',c.updated],['board',c.board],['file',c.file]]
    .filter(r=>r[1]);
  d.innerHTML='<button class="close" title="close">✕</button>'
    +'<div class="cid">'+esc(c.id)+'</div><h2>'+esc(c.title)+'</h2>'
    +'<span class="statechip" style="background:'+stateColor(c.state)+'">'+c.state+'</span>'
    +'<table>'+rows.map(r=>'<tr><td>'+r[0]+'</td><td>'+esc(r[1])+'</td></tr>').join('')+'</table>'
    +'<div class="body">'+(c.body&&c.body.trim()?md(c.body):'<p class="empty">no body</p>')+'</div>';
  d.classList.add('open');
  $('.close',d).onclick=()=>d.classList.remove('open');
}
document.addEventListener('click',e=>{
  const go=e.target.closest('[data-goto]');
  if(go&&!go.disabled){CUR=go.dataset.goto;render();e.stopPropagation();return}
  const el=e.target.closest('[data-card]');
  if(el){const b=DATA.boards[CUR];for(const lane of b.lanes){const c=lane.cards.find(x=>x.id===el.dataset.card);if(c){openDrawer(c);return}}}
});
document.addEventListener('keydown',e=>{if(e.key==='Escape')$('#drawer').classList.remove('open')});
$('#switch').addEventListener('change',e=>{CUR=e.target.value;render()});
async function poll(){
  try{const r=await fetch('/api/data');const next=await r.text();
    if(next!==JSON.stringify(DATA)&&!$('#drawer').classList.contains('open')){DATA=JSON.parse(next);render()}
  }catch{}
}
if(DATA)render();
if(LIVE){if(!DATA)poll().then(()=>render());setInterval(poll,2000)}
`;

const escHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function viewerHtml(data: ViewerData | null, opts: { live: boolean; title?: string }): string {
  const payload = data === null ? 'null' : JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(opts.title ?? 'botflow')}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1><span id="title">botflow</span> <span class="sub" id="sub"></span></h1>
  <select id="switch" style="display:none" aria-label="board"></select>
  <div class="meter"><span class="lbl">progress</span><div class="track"><div class="fill" id="pfill" style="width:0"></div></div><span class="num" id="pnum">·</span></div>
  <div class="dist"><div class="strip" id="strip" role="img" aria-label="cards by state"></div><div class="chips" id="chips"></div></div>
  <div class="lintchips" id="lint"></div>
</header>
<main></main>
<footer id="findings"></footer>
<div id="drawer"></div>
<script>window.__BOTFLOW__=${payload};window.__LIVE__=${opts.live};</script>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}
