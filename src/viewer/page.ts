// The read-only board page: one self-contained HTML file, zero dependencies.
// Used two ways: `botflow board --html` embeds a data snapshot; `botflow serve`
// serves the same page in live mode, polling /api/data.
//
// The page paints from the shared UI token layer (src/ui/themes.ts): the same
// five visual worlds, tuned accents, and CVD-validated workflow-state palettes
// the hosted manager uses, chosen locally (style, accent, mode persist in
// localStorage). One structural stylesheet, tokens do the rest.

import type { Analysis } from '../core/analyze.ts';
import { lintBoard } from '../core/analyze.ts';
import type { Tree } from '../core/load.ts';
import { boardJson, cardJson } from '../cli/render.ts';
import { DEFAULT_CARD_TAG_LIMIT, MAX_CARD_TAG_LIMIT } from '../ui/card-face.ts';
import { STYLES } from '../ui/themes.ts';

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
      estimate: node.board.cards.filter((c) => c.laneId === lane.id).reduce((sum, card) => sum + (card.estimate ?? 0), 0),
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
  --page:#f2f6f7;--surface:#fdfefe;--surface2:#e7eef0;--ink:#12181a;--ink2:#4c5a5e;--muted:#7d8c90;
  --grid:#d8e2e4;--baseline:#b6c5c9;--ring:rgba(18,24,26,.10);--acc:#0e7a8a;--acc-ink:#ffffff;
  --st-wishlist:#b6c5c9;--st-todo:#7d8c90;--st-blocked:#d03b3b;--st-doing:#2a78d6;--st-done:#0ca30c;--st-archive:#d8e2e4;
  --rc:10px;--rk:6px;--bw:1px;--bs:solid;--shadow:0 1px 3px rgba(0,0,0,.06);
  --font:system-ui,-apple-system,"Segoe UI",sans-serif;--display:var(--font)}
*{box-sizing:border-box;margin:0}
body{background:var(--page);color:var(--ink);font:14px/1.45 var(--font);min-height:100vh}
header{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--page) 88%,transparent);backdrop-filter:blur(10px);border-bottom:var(--bw) var(--bs) var(--grid);padding:14px 20px 12px;display:flex;flex-wrap:wrap;gap:14px 26px;align-items:center}
h1{font:650 17px/1.2 var(--display);display:flex;gap:10px;align-items:baseline}
h1 .sub{color:var(--muted);font-size:12px;font-weight:400}
select,header button{font:inherit;color:var(--ink);background:var(--surface);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rk);padding:3px 8px;cursor:pointer}
.viewctl{display:flex;gap:5px;align-items:center}.viewctl select{max-width:150px}.viewctl [hidden]{display:none}
select:focus-visible,button:focus-visible,[data-card]:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
.meter{display:flex;align-items:center;gap:8px}
.meter .track{width:160px;height:8px;border-radius:4px;background:var(--grid);overflow:hidden}
.meter .fill{height:100%;border-radius:4px;background:var(--acc)}
.meter .num{font-weight:650}
.meter .lbl{color:var(--muted);font-size:12px}
.dist{display:flex;flex-direction:column;gap:6px;min-width:230px}
.strip{display:flex;gap:2px;height:12px;border-radius:4px;overflow:hidden;background:var(--grid)}
.strip i{display:block;height:100%;min-width:8px}
.chips{display:flex;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--ink2)}
.chips b{font-weight:650;color:var(--ink)}
.chips .z{opacity:.45}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:baseline;border:1px solid var(--ring)}
.lintchips{margin-left:auto;display:flex;gap:8px;font-size:12px}
.lintchips a{color:inherit;text-decoration:none;border:var(--bw) var(--bs) var(--grid);border-radius:999px;padding:2px 9px;background:var(--surface)}
.lintchips .e{color:var(--st-blocked);font-weight:650}
.lintchips .w{color:#c47317;font-weight:650}
.themectl{display:flex;gap:6px;align-items:center}
.themectl .lbl{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
main{display:block;padding:16px 20px 40px;overflow-x:auto;position:relative}
main[data-layout=kanban]{display:flex;gap:12px;align-items:flex-start}
.relsvg{position:absolute;inset:0;overflow:visible;pointer-events:none;z-index:1}
.relsvg path{fill:none;stroke:var(--st-blocked);stroke-width:2;opacity:.58;vector-effect:non-scaling-stroke}
.relsvg path.resolved{stroke:var(--muted);stroke-dasharray:4 4;opacity:.4}
.col{background:var(--surface);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);min-width:270px;width:270px;flex:none;padding:10px;box-shadow:var(--shadow)}
.col h2{font:700 12px/1.25 var(--display);text-transform:uppercase;letter-spacing:.04em;color:var(--ink2);display:flex;gap:6px;align-items:baseline;padding:2px 4px 8px}
.col h2 .n{color:var(--muted);font-weight:400}
.col h2 .wipbad{color:var(--st-blocked);font-weight:650}
.col h2 .canon{color:var(--muted);font-weight:400;text-transform:none}
.sub-h{font-size:11px;color:var(--muted);padding:6px 4px 2px;border-top:1px dashed var(--grid);margin-top:6px}
.card{border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);padding:0;margin:6px 0;background:var(--page);cursor:pointer;overflow:hidden;transition:opacity .12s ease,filter .12s ease;position:relative;z-index:2}
.card:hover{border-color:var(--baseline)}
.card.blocked{border-left:3px solid var(--st-blocked)}
.card.has-color::before{content:"";display:block;height:5px;background:var(--cover-color)}
.card.age-1:not(:hover):not(:focus-within){opacity:.9}.card.age-2:not(:hover):not(:focus-within){opacity:.8}.card.age-3:not(:hover):not(:focus-within){opacity:.68;filter:saturate(.65)}
.card .art{width:100%;height:90px;object-fit:cover;display:block;border-bottom:var(--bw) var(--bs) var(--grid)}
.card .inner{padding:8px 10px}
.card .cid{font:11px ui-monospace,Menlo,monospace;color:var(--muted)}
.card .t{font-weight:550;margin:1px 0 4px}
.badges{display:flex;flex-wrap:wrap;gap:5px;font-size:11px;color:var(--ink2)}
.badges span{border:var(--bw) var(--bs) var(--grid);border-radius:999px;padding:1px 7px;background:var(--surface)}
.badges .ready{color:var(--st-done);font-weight:650}
.badges .p0{color:var(--st-blocked);font-weight:650}
.badges .p1{color:#c47317;font-weight:650}
.badges .blk{color:var(--st-blocked)}
.badges .due-overdue,.badges .due-today{color:var(--st-blocked);font-weight:650}.badges .due-soon{color:#c47317;font-weight:650}
.badges .lbl{box-shadow:inset 3px 0 0 var(--lc)}.badges .moretags{color:var(--muted);border-style:dashed}.badges .fieldface b{font-weight:600;color:var(--muted)}
.previewtasks{margin-top:6px;padding-top:5px;border-top:1px dashed var(--grid);font-size:11px;color:var(--ink2);display:flex;flex-direction:column;gap:2px}.previewtasks span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.previewtasks span::before{content:"□ ";color:var(--muted)}
.subboard{margin-top:7px;display:flex;gap:8px;align-items:center}
.subboard button{font:12px var(--font);border:var(--bw) var(--bs) var(--grid);background:var(--surface);color:var(--ink);border-radius:var(--rk);padding:2px 8px;cursor:pointer}
.subboard .mini{flex:1;height:6px;border-radius:3px;background:var(--grid);overflow:hidden}
.subboard .mini i{display:block;height:100%;background:var(--acc)}
.statechip{font-size:11px;border-radius:999px;padding:1px 8px;color:#fff}
footer{padding:0 20px 40px;max-width:900px}
footer h3{font-size:13px;margin-bottom:8px;color:var(--ink2)}
.finding{font:12px ui-monospace,Menlo,monospace;padding:3px 0;color:var(--ink2)}
.finding b{color:var(--st-blocked)} .finding i{color:#c47317;font-style:normal}
#drawer{position:fixed;top:0;right:0;bottom:0;width:min(480px,92vw);background:var(--surface);border-left:var(--bw) var(--bs) var(--grid);box-shadow:-12px 0 30px rgba(0,0,0,.12);padding:20px;overflow-y:auto;display:none;z-index:10}
#drawer.open[aria-hidden="false"]{display:block}
#drawer .close{float:right;border:none;background:none;font-size:18px;color:var(--muted);cursor:pointer}
#drawer h2{font:650 16px/1.3 var(--display);margin:2px 0 10px}
#drawer table{font-size:12px;border-collapse:collapse;margin:10px 0}
#drawer td{padding:2px 10px 2px 0;vertical-align:top;color:var(--ink2)}
#drawer td:first-child{color:var(--muted)}
#drawer .body{border-top:var(--bw) var(--bs) var(--grid);margin-top:12px;padding-top:12px;font-size:13px}
#drawer .body h4{margin:12px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink2)}
#drawer .body ul{padding-left:20px;margin:4px 0}
#drawer .body li.done{color:var(--muted);text-decoration:line-through}
#drawer .body code{font:12px ui-monospace,Menlo,monospace;background:var(--page);border:var(--bw) var(--bs) var(--grid);border-radius:4px;padding:0 4px}
#drawer .body pre{background:var(--page);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rk);padding:10px;overflow-x:auto;font:12px ui-monospace,Menlo,monospace;margin:6px 0}
.relations{display:flex;flex-direction:column;gap:5px;margin:8px 0 14px}.relation{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center;border:var(--bw) var(--bs) var(--grid);border-radius:var(--rk);padding:5px 7px;font-size:12px}.relation .rtype{font-weight:650}.relation .rsrc{color:var(--muted);font-size:11px}
.empty{color:var(--muted);font-size:12px;padding:6px 4px}
.cardtable{border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);overflow:auto;background:var(--surface)}.cardtable table{border-collapse:collapse;width:100%;min-width:980px;font-size:13px}.cardtable td,.cardtable th{text-align:left;padding:7px 9px;border-bottom:var(--bw) var(--bs) var(--grid)}.cardtable th{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}.cardtable th button{border:0;background:none;padding:0;color:inherit;text-transform:inherit;letter-spacing:inherit}.cardtable tr[data-card]{cursor:pointer}.cardtable tr[data-card]:hover,.cardtable tr[data-card]:focus-visible{background:var(--surface2)}.cardtable tr[data-card]:focus-visible{outline:2px solid var(--acc);outline-offset:-2px}.cardtable .mono{font:11px ui-monospace,Menlo,monospace}.cardtable .titlecell{min-width:210px;font-weight:600}
.axiscols{display:flex;gap:12px;align-items:flex-start}.axiscol{background:var(--surface);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);min-width:270px;width:270px;padding:10px;box-shadow:var(--shadow)}.axiscol h2{font:700 12px/1.25 var(--display);text-transform:uppercase;letter-spacing:.04em;color:var(--ink2);padding:2px 4px 8px}.axiscol h2 span{color:var(--muted);font-weight:400}
.swimwrap{overflow:auto;border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);background:var(--surface)}.swim{display:grid;min-width:max-content}.swimhead,.swimlabel,.swimcell{padding:8px;border-right:var(--bw) var(--bs) var(--grid);border-bottom:var(--bw) var(--bs) var(--grid)}.swimhead{position:sticky;top:0;z-index:4;background:var(--surface2);font:700 11px var(--display);text-transform:uppercase;color:var(--ink2)}.swimlabel{position:sticky;left:0;z-index:3;background:var(--surface2);font-weight:650;min-width:150px}.swimlabel small{display:block;color:var(--muted);font-weight:400}.swimcell{width:240px;min-height:72px}.swimcell .card{margin:0 0 6px}
.calendar .calbar{display:flex;justify-content:center;align-items:center;gap:8px;margin-bottom:8px}.calbar h2{font:700 14px var(--display);min-width:170px;text-align:center}.calgrid{display:grid;grid-template-columns:repeat(7,minmax(120px,1fr));min-width:840px;border-top:var(--bw) var(--bs) var(--grid);border-left:var(--bw) var(--bs) var(--grid);background:var(--surface)}.caldayname{padding:5px 7px;background:var(--surface2);font-size:10px;text-transform:uppercase;color:var(--muted);border-right:var(--bw) var(--bs) var(--grid);border-bottom:var(--bw) var(--bs) var(--grid)}.calday{min-height:110px;padding:5px;border-right:var(--bw) var(--bs) var(--grid);border-bottom:var(--bw) var(--bs) var(--grid)}.calday.out{background:var(--page);opacity:.62}.calday.today{box-shadow:inset 0 0 0 2px var(--acc)}.caldate{font:11px ui-monospace,Menlo,monospace;color:var(--muted);margin-bottom:4px}.calcard{display:block;width:100%;text-align:left;border:0;border-left:3px solid var(--state-color);background:var(--surface2);color:var(--ink);padding:3px 5px;margin:3px 0;font:11px var(--font);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.timeline{min-width:760px}.tlaxis{margin-left:230px;display:flex;justify-content:space-between;color:var(--muted);font:10px ui-monospace,Menlo,monospace;padding-bottom:5px}.tlrow{display:grid;grid-template-columns:220px minmax(520px,1fr);gap:10px;align-items:center;min-height:38px}.tllabel{border:0;background:none;text-align:left;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}.tllabel code{font-size:10px;color:var(--muted)}.tltrack{height:24px;position:relative;border-left:var(--bw) var(--bs) var(--grid);border-right:var(--bw) var(--bs) var(--grid);background:repeating-linear-gradient(90deg,var(--surface2) 0,var(--surface2) 1px,transparent 1px,transparent 10%)}.tlbar{position:absolute;top:4px;height:16px;min-width:5px;border:0;border-radius:999px;background:var(--state-color);cursor:pointer}
.metricgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.metric{background:var(--surface);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);padding:13px;box-shadow:var(--shadow)}.metric b{display:block;font:700 22px/1 var(--display)}.metric span{font-size:11px;color:var(--muted)}.chartgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px;margin-top:12px}.chart{background:var(--surface);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);padding:12px}.chart h2{font:700 12px var(--display);margin-bottom:8px}.bars{height:150px;display:flex;align-items:flex-end;gap:3px;border-bottom:var(--bw) var(--bs) var(--grid)}.bars i{flex:1;min-width:2px;background:var(--acc)}.cfbars{height:150px;display:flex;align-items:flex-end;gap:2px}.cfbar{flex:1;height:100%;display:flex;flex-direction:column-reverse}.cfbar i{display:block;min-height:1px}.metriclist{display:grid;gap:5px;font-size:12px}.metriclist div{display:flex;gap:10px}.metriclist b{margin-left:auto}
.hillview{background:var(--surface);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);padding:14px;box-shadow:var(--shadow)}.hillnote{color:var(--muted);font-size:12px;margin-bottom:8px}.hillplot{height:270px;position:relative;overflow:hidden;border-bottom:var(--bw) var(--bs) var(--grid)}.hillplot svg{position:absolute;inset:18px 4% 34px;width:92%;height:200px}.hillplot path{fill:none;stroke:var(--grid);stroke-width:5;vector-effect:non-scaling-stroke}.hillplot .crest{position:absolute;left:50%;top:17px;bottom:34px;border-left:1px dashed var(--grid)}.hillphase{position:absolute;bottom:8px;color:var(--muted);font-size:11px}.hillphase.up{left:10%}.hillphase.down{right:10%}.hilldot{position:absolute;width:18px;height:18px;border-radius:50%;transform:translate(-50%,-50%);background:var(--state-color);border:3px solid var(--surface);box-shadow:0 1px 5px rgba(0,0,0,.3)}.hilldot.unset{background:var(--muted);opacity:.7}.hilllegend{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:6px;margin-top:10px}.hillitem{display:flex;align-items:center;gap:7px;font-size:12px}.hillitem i{width:9px;height:9px;border-radius:50%;background:var(--state-color)}.hillitem button{border:0;background:none;padding:2px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hillitem code{margin-left:auto;color:var(--muted);font-size:10px}

@media (max-width: 760px){
  header{padding:10px 12px;gap:10px 16px}
  .meter .track{width:90px}
  .dist{min-width:0}
  main{padding:10px 12px 30px}main[data-layout=kanban]{scroll-snap-type:x mandatory}
  .col{width:84vw;min-width:84vw;scroll-snap-align:start}
  #drawer{width:100vw}
  .themectl{order:9}
}

/* Per-world flair, ported compactly from the manager's sheet. */
html[data-style=harbor] body{background-image:radial-gradient(circle at 5% 0%,color-mix(in srgb,var(--acc) 14%,transparent) 0,transparent 30%);background-attachment:fixed}
html[data-style=harbor] .card{border-color:color-mix(in srgb,var(--grid) 76%,transparent);box-shadow:inset 0 3px 0 color-mix(in srgb,var(--acc) 38%,transparent)}
html[data-style=phosphor] body{background-image:linear-gradient(color-mix(in srgb,var(--acc) 7%,transparent) 1px,transparent 1px),linear-gradient(90deg,color-mix(in srgb,var(--acc) 7%,transparent) 1px,transparent 1px);background-size:24px 24px;background-attachment:fixed}
html[data-style=phosphor] h1,html[data-style=phosphor] .col h2{text-transform:uppercase;letter-spacing:.04em}
html[data-style=phosphor] h1::before{content:">_ ";color:var(--acc)}
html[data-style=phosphor] .card{border-left:2px solid var(--acc)}
html[data-style=phosphor] .statechip,html[data-style=phosphor] .badges span,html[data-style=phosphor] .strip,html[data-style=phosphor] .meter .track{border-radius:0}
html[data-style=fieldnotes] body{background-image:repeating-linear-gradient(to bottom,transparent 0,transparent 31px,color-mix(in srgb,var(--baseline) 22%,transparent) 32px)}
html[data-style=fieldnotes] h1{font-style:italic;letter-spacing:-.025em}
html[data-style=fieldnotes] .col{border-top:3px double var(--ink)}
html[data-style=fieldnotes] .card:not(.blocked){border-left:3px double var(--acc)}
html[data-style=fieldnotes] .card{box-shadow:1px 2px 0 color-mix(in srgb,var(--ink) 18%,transparent)}
html[data-style=mochi] body{background-image:radial-gradient(circle at 8% 2%,color-mix(in srgb,var(--acc) 15%,transparent) 0,transparent 25%);background-attachment:fixed}
html[data-style=mochi] .card{border-color:color-mix(in srgb,var(--grid) 45%,transparent);box-shadow:inset 0 4px 0 color-mix(in srgb,var(--acc) 54%,transparent)}
html[data-style=blockparty] body{background-image:radial-gradient(color-mix(in srgb,var(--grid) 18%,transparent) .9px,transparent .9px);background-size:16px 16px;background-attachment:fixed}
html[data-style=blockparty] header{border-top:8px solid var(--acc);border-bottom-width:2px}
html[data-style=blockparty] h1,html[data-style=blockparty] .col h2{text-transform:uppercase;letter-spacing:.025em}
html[data-style=blockparty] .card{box-shadow:3px 3px 0 var(--grid)}
html[data-style=blockparty] .statechip{border:1px solid var(--grid);font-weight:800;text-transform:uppercase}
`;

const CLIENT_JS = `
const ORDER=['wishlist','todo','blocked','doing','done','archive'];
const $=(s,el)=>(el||document).querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const imageOk=u=>{try{const x=new URL(u,location.href);return x.protocol==='data:'?/^data:image\//i.test(u):x.protocol==='blob:'||((x.protocol==='http:'||x.protocol==='https:')&&x.origin===location.origin)}catch{return false}};
let DATA=window.__BOTFLOW__||null,CUR='.',LIVE=window.__LIVE__===true;
let LAYOUT=localStorage.getItem('bfv_layout')||'kanban';
if(!['kanban','table','swimlane','calendar','timeline','grouped','metrics','hill'].includes(LAYOUT))LAYOUT='kanban';
let GROUP_AXIS=localStorage.getItem('bfv_group_axis')||'assignee',SWIM_AXIS=localStorage.getItem('bfv_swim_axis')||'assignee',CAL_MONTH=null,TABLE_SORT='id',TABLE_DESC=false;
const STORED_CARD_TAG_LIMIT=localStorage.getItem('bfv_card_tag_limit');
let CARD_TAG_LIMIT=STORED_CARD_TAG_LIMIT===null?${DEFAULT_CARD_TAG_LIMIT}:Number(STORED_CARD_TAG_LIMIT);
if(!Number.isInteger(CARD_TAG_LIMIT)||CARD_TAG_LIMIT<0||CARD_TAG_LIMIT>${MAX_CARD_TAG_LIMIT})CARD_TAG_LIMIT=${DEFAULT_CARD_TAG_LIMIT};
// ---- shared theme layer (same worlds as the hosted manager) ----
const THEMES=window.__THEMES__;
const mq=matchMedia('(prefers-color-scheme: dark)');
let THEME={style:'harbor',accent:null,mode:'system'};
try{Object.assign(THEME,JSON.parse(localStorage.getItem('bfv_theme')||'{}'))}catch{}
function contrastInk(hex){
  const ch=n=>{const c=n/255;return c<=.04045?c/12.92:Math.pow((c+.055)/1.055,2.4)};
  const n=parseInt(hex.slice(1),16),l=.2126*ch(n>>16&255)+.7152*ch(n>>8&255)+.0722*ch(n&255);
  return 1.05/(l+.05)>=(l+.05)/.05?'#ffffff':'#141414';
}
function applyTheme(){
  const st=THEMES.find(s=>s.id===THEME.style)||THEMES[0];
  const mode=THEME.mode==='light'||THEME.mode==='dark'?THEME.mode:(mq.matches?'dark':'light');
  const p=st[mode];
  const acc=(st.accents.find(a=>a.id===THEME.accent)||st.accents[0])[mode];
  const R=document.documentElement.style,set=(k,v)=>R.setProperty(k,v);
  set('--page',p.page);set('--surface',p.surface);set('--surface2',p.surface2);set('--ink',p.ink);set('--ink2',p.ink2);
  set('--muted',p.muted);set('--grid',p.grid);set('--baseline',p.baseline);set('--ring',p.ring);
  set('--st-wishlist',p.stWishlist);set('--st-todo',p.stTodo);set('--st-blocked',p.stBlocked);
  set('--st-doing',p.stDoing);set('--st-done',p.stDone);set('--st-archive',p.stArchive);
  set('--acc',acc.acc);set('--acc-ink',acc.accInk||contrastInk(acc.acc));
  set('--rc',st.radiusCard);set('--rk',st.radiusCtl);set('--bw',st.borderW);set('--bs',st.borderStyle||'solid');
  set('--shadow',mode==='dark'?st.shadowDark:st.shadowLight);set('--font',st.font);set('--display',st.displayFont);
  document.documentElement.dataset.style=st.id;
  document.documentElement.style.colorScheme=mode;
  const ts=$('#tstyle');if(ts)ts.value=st.id;
  const ta=$('#taccent');if(ta){ta.innerHTML=st.accents.map(a=>'<option value="'+a.id+'" '+((THEME.accent||st.accents[0].id)===a.id?'selected':'')+'>'+esc(a.name)+'</option>').join('')}
  const tm=$('#tmode');if(tm)tm.textContent=THEME.mode==='light'?'☀':THEME.mode==='dark'?'☾':'auto';
  const tl=$('#taglimit');if(tl)tl.value=String(CARD_TAG_LIMIT);
}
function saveTheme(){localStorage.setItem('bfv_theme',JSON.stringify(THEME));applyTheme()}
mq.addEventListener('change',applyTheme);
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
function fieldText(v){return Array.isArray(v)?v.join(', '):v===true?'yes':v===false?'no':String(v)}
function labelBadge(l){return '<span class="lbl" style="--lc:'+esc(l.color||'var(--grid)')+'" title="'+esc(l.group?l.group+': '+l.value:l.id)+'">#'+esc(l.value||l.id)+'</span>'}
function cardTagBadges(c){
  const details=c.labelDetails||[];
  const tags=details.length
    ?details.map(l=>({html:labelBadge(l),text:'#'+(l.value||l.id)}))
    :(c.labels||[]).map(l=>({html:'<span>#'+esc(l)+'</span>',text:'#'+l}));
  const visible=tags.slice(0,CARD_TAG_LIMIT),hidden=tags.slice(CARD_TAG_LIMIT);
  const out=visible.map(t=>t.html);
  if(hidden.length)out.push('<span class="moretags" title="'+esc(hidden.map(t=>t.text).join(', '))+'">+'+hidden.length+' more</span>');
  return out;
}
function dueFace(c){
  const d=c.metrics&&c.metrics.due;if(!d||d.status==='complete')return null;
  const text=d.status==='overdue'?Math.abs(d.days)+'d late':d.status==='today'?'due today':d.days+'d';
  return '<span class="due-'+d.status+'" title="due '+esc(c.due)+'">◷ '+text+'</span>'}
function badge(c){
  const b=[];
  if(c.priority)b.push('<span class="'+(c.priority==='p0'?'p0':c.priority==='p1'?'p1':'')+'">'+c.priority+'</span>');
  if(c.blocked)b.push('<span class="blk" title="'+esc(c.blocked)+'">⛔ blocked</span>');
  const due=dueFace(c);if(due)b.push(due);
  if(c.metrics&&c.metrics.dueChanges)b.push('<span title="due date changed '+c.metrics.dueChanges+' time(s)">↻ '+c.metrics.dueChanges+'</span>');
  if(c.assignee)b.push('<span title="accountable assignee">@'+esc(c.assignee)+'</span>');
  if(c.delegate)b.push('<span title="executing delegate">⇢ @'+esc(c.delegate)+'</span>');
  const tagIndex=b.length;
  if(c.checklist)b.push('<span>☑ '+c.checklist.done+'/'+c.checklist.total+'</span>');
  if(c.estimate)b.push('<span>est '+c.estimate+'</span>');
  for(const f of c.faceFields||[])b.push('<span class="fieldface"><b>'+esc(f.name)+'</b> '+esc(fieldText(f.value))+'</span>');
  if(c.descriptionPresent)b.push('<span title="description">≡</span>');
  if(c.comments)b.push('<span title="comments">◌ '+c.comments+'</span>');
  if(c.attachments)b.push('<span title="attachments">⌕ '+c.attachments+'</span>');
  if((c.watchers||[]).length)b.push('<span title="watchers">◉ '+c.watchers.length+'</span>');
  if(c.voteCount)b.push('<span title="votes">▲ '+c.voteCount+'</span>');
  if(c.boostCount)b.push('<span title="boosts">✦ '+c.boostCount+'</span>');
  const s=c.metrics&&c.metrics.stagnation;if(s&&s.dots)b.push('<span title="'+s.days+' cumulative days in lane">'+('●'.repeat(s.dots))+'</span>');
  if(READY.has(c.id))b.push('<span class="ready">▶ ready</span>');
  const shown=b.slice(0,10);shown.splice(tagIndex,0,...cardTagBadges(c));
  return shown.join('')}
let READY=new Set();
function cardHtml(c){
  const board=c.type==='board';
  const child=board&&c.child!=null?DATA.boards[c.child]:null;
  const age=c.metrics&&c.metrics.agingLevel||0;
  return '<div class="card '+(c.blocked?'blocked ':'')+(c.coverColor?'has-color ':'')+(age?'age-'+age:'')+'"'+(c.coverColor?' style="--cover-color:'+esc(c.coverColor)+'"':'')+' data-card="'+esc(c.id)+'" tabindex="0" role="button">'
    +(c.cover&&imageOk(c.cover)?'<img class="art" src="'+esc(c.cover)+'" alt="" loading="lazy" referrerpolicy="no-referrer">':'')
    +'<div class="inner"><div class="cid">'+esc(c.id)+'</div><div class="t">'+esc(c.title)+'</div>'
    +'<div class="badges">'+badge(c)+'</div>'
    +((c.checklistPreview||[]).length?'<div class="previewtasks">'+c.checklistPreview.slice(0,2).map(i=>'<span title="'+esc(i.section)+'">'+esc(i.text)+'</span>').join('')+'</div>':'')
    +(board?'<div class="subboard"><button data-goto="'+esc(c.child??'')+'" '+(c.child==null?'disabled':'')+'>⇒ '+esc(c.child??c.board??'?')+'</button>'
      +'<span class="statechip" style="background:'+stateColor(c.state)+'">'+c.state+'</span>'
      +(child?'<div class="mini" title="child progress '+pct(child.progress)+'"><i style="width:'+Math.round((child.progress||0)*100)+'%"></i></div>':'')
      +'</div>':'')
    +'</div></div>'}
function flatCards(b){return (b.lanes||[]).flatMap(l=>l.cards||[])}
function cardField(c,id){const f=(c.fields||[]).find(x=>x.id===id);return f?f.value:null}
function uniqValues(values){const seen=new Set(),out=[];for(const raw of values){if(raw===null||raw===undefined||raw==='')continue;const id=String(raw);if(!seen.has(id)){seen.add(id);out.push({id:id,label:id})}}return out.sort((a,z)=>a.label.localeCompare(z.label))}
function axisDefs(b){
  const cards=flatCards(b),defs=[{id:'lane',label:'lane',kind:'lane',values:(b.lanes||[]).map(l=>({id:l.id,label:l.name}))},
    {id:'assignee',label:'assignee',kind:'assignee',values:uniqValues(cards.map(c=>c.assignee))},
    {id:'delegate',label:'delegate',kind:'delegate',values:uniqValues(cards.map(c=>c.delegate))},
    {id:'priority',label:'priority',kind:'priority',values:['p0','p1','p2','p3'].map(id=>({id:id,label:id}))}];
  const groups=new Map();for(const c of cards)for(const l of c.labelDetails||[])if(l.group){if(!groups.has(l.group))groups.set(l.group,new Set());groups.get(l.group).add(l.value)}
  for(const l of b.labels||[]){const at=l.id.indexOf('/');if(at>0&&at<l.id.length-1){const g=l.id.slice(0,at),v=l.id.slice(at+1);if(!groups.has(g))groups.set(g,new Set());groups.get(g).add(v)}}
  for(const [group,values] of [...groups].sort((a,z)=>a[0].localeCompare(z[0])))defs.push({id:'label:'+group,label:'label · '+group,kind:'label',group:group,values:uniqValues([...values])});
  for(const f of b.fields||[]){if(!['select','person','checkbox'].includes(f.type))continue;const values=f.type==='select'?(f.options||[]).map(id=>({id:id,label:id})):f.type==='checkbox'?[{id:'true',label:'yes'},{id:'false',label:'no'}]:uniqValues(cards.map(c=>cardField(c,f.id)));defs.push({id:'field:'+f.id,label:'field · '+f.name,kind:'field',field:f,values:values})}
  return defs;
}
function axisValue(axis,c){if(axis.kind==='lane')return c.lane||'';if(axis.kind==='assignee'||axis.kind==='delegate'||axis.kind==='priority')return c[axis.kind]||'';if(axis.kind==='label'){const l=(c.labelDetails||[]).find(x=>x.group===axis.group);return l?String(l.value):''}const value=cardField(c,axis.field.id);return value===null||value===undefined||value===''?'':String(value)}
function chosenAxis(b,id){const axes=axisDefs(b);return axes.find(a=>a.id===id)||axes[0]}
function syncViewControls(b){
  const layout=$('#layout');if(layout)layout.value=LAYOUT;const ctl=$('#axis');if(!ctl)return;const grouped=LAYOUT==='grouped'||LAYOUT==='swimlane';ctl.hidden=!grouped;if(!grouped)return;
  const axes=axisDefs(b),wanted=LAYOUT==='grouped'?GROUP_AXIS:SWIM_AXIS,selected=axes.some(a=>a.id===wanted)?wanted:'assignee';if(LAYOUT==='grouped')GROUP_AXIS=selected;else SWIM_AXIS=selected;
  ctl.innerHTML=axes.map(a=>'<option value="'+esc(a.id)+'"'+(a.id===selected?' selected':'')+'>'+esc(a.label)+'</option>').join('');
}
function tableValue(c,key){if(key==='title')return c.title||'';if(key==='state')return c.state||'';if(key==='lane')return c.position||'';if(key==='assignee')return c.assignee||'';if(key==='due')return c.due||'';if(key==='estimate')return c.estimate??-1;if(key==='hill')return c.hill??-1;return c.id||''}
function tableHtml(b){const cards=[...flatCards(b)].sort((a,z)=>{const av=tableValue(a,TABLE_SORT),zv=tableValue(z,TABLE_SORT),n=typeof av==='number'&&typeof zv==='number'?av-zv:String(av).localeCompare(String(zv),undefined,{numeric:true});return TABLE_DESC?-n:n});const th=(key,label)=>'<th><button data-sort="'+key+'">'+label+(TABLE_SORT===key?(TABLE_DESC?' ↓':' ↑'):'')+'</button></th>';
  return '<div class="cardtable"><table><thead><tr>'+th('id','id')+th('title','title')+th('state','state')+th('lane','position')+th('assignee','assignee')+'<th>delegate</th><th>priority</th>'+th('due','due')+th('estimate','estimate')+th('hill','hill')+'<th>labels</th><th>idle</th></tr></thead><tbody>'+cards.map(c=>'<tr data-card="'+esc(c.id)+'" tabindex="0" role="button"><td class="mono">'+esc(c.id)+'</td><td class="titlecell">'+esc(c.title)+'</td><td><span class="statechip" style="background:'+stateColor(c.state)+'">'+esc(c.state)+'</span></td><td class="mono">'+esc(c.position)+'</td><td>'+esc(c.assignee||'—')+'</td><td>'+esc(c.delegate||'—')+'</td><td>'+esc(c.priority||'—')+'</td><td class="mono">'+esc(c.due||'—')+'</td><td>'+esc(c.estimate??'—')+'</td><td>'+esc(c.hill??'—')+'</td><td>'+esc((c.labels||[]).join(', '))+'</td><td>'+esc(c.metrics&&c.metrics.idleDays!=null?c.metrics.idleDays+'d':'—')+'</td></tr>').join('')+'</tbody></table></div>'}
function groupedHtml(b){const cards=flatCards(b),axis=chosenAxis(b,GROUP_AXIS),values=axis.kind==='lane'?(axis.values||[]):[{id:'',label:'unset'}].concat(axis.values||[]);return '<div class="axiscols">'+values.map(v=>{const cs=cards.filter(c=>axisValue(axis,c)===v.id);return '<section class="axiscol"><h2>'+esc(v.label)+' <span>'+cs.length+'</span></h2>'+(cs.length?cs.map(cardHtml).join(''):'<div class="empty">·</div>')+'</section>'}).join('')+'</div>'}
function swimlaneHtml(b){const cards=flatCards(b),axis=chosenAxis(b,SWIM_AXIS),lanes=b.lanes||[];let values=(axis.kind==='lane'?(axis.values||[]):[{id:'',label:'unset'}].concat(axis.values||[])).filter(v=>cards.some(c=>axisValue(axis,c)===v.id));if(!values.length)values=[{id:'',label:'unset'}];let out='<div class="swimwrap"><div class="swim" style="grid-template-columns:160px repeat('+lanes.length+',240px)"><div class="swimhead">'+esc(axis.label)+'</div>'+lanes.map(l=>'<div class="swimhead">'+esc(l.name)+'</div>').join('');for(const v of values){const row=cards.filter(c=>axisValue(axis,c)===v.id);out+='<div class="swimlabel">'+esc(v.label)+'<small>'+row.length+' card'+(row.length===1?'':'s')+'</small></div>';for(const lane of lanes){const cs=row.filter(c=>c.lane===lane.id);out+='<div class="swimcell">'+(cs.length?cs.map(cardHtml).join(''):'<span class="empty">·</span>')+'</div>'}}return out+'</div></div>'}
function isoDay(value){const s=String(value||'').slice(0,10);return /^\\d{4}-\\d{2}-\\d{2}$/.test(s)?s:null}function utcDay(value){const s=isoDay(value);return s?Math.floor(Date.parse(s+'T00:00:00Z')/86400000):null}function dayIso(day){return new Date(day*86400000).toISOString().slice(0,10)}
function calendarHtml(b){const cards=flatCards(b).filter(c=>isoDay(c.due)),now=new Date(),fallback=now.toISOString().slice(0,7);if(!CAL_MONTH)CAL_MONTH=fallback;let p=CAL_MONTH.split('-').map(Number),year=p[0],month=p[1]-1;if(!Number.isInteger(year)||month<0||month>11){CAL_MONTH=fallback;p=CAL_MONTH.split('-').map(Number);year=p[0];month=p[1]-1}const first=Math.floor(Date.UTC(year,month,1)/86400000),start=first-new Date(first*86400000).getUTCDay(),today=now.toISOString().slice(0,10),name=new Intl.DateTimeFormat(undefined,{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(Date.UTC(year,month,1)));let out='<div class="calendar"><div class="calbar"><button data-cal="-1">←</button><h2>'+esc(name)+'</h2><button data-cal="today">today</button><button data-cal="1">→</button></div><div class="calgrid">'+['sun','mon','tue','wed','thu','fri','sat'].map(d=>'<div class="caldayname">'+d+'</div>').join('');for(let i=0;i<42;i++){const day=start+i,date=dayIso(day),inside=new Date(day*86400000).getUTCMonth()===month;out+='<div class="calday '+(inside?'':'out ')+(date===today?'today':'')+'"><div class="caldate">'+date.slice(8)+'</div>'+cards.filter(c=>isoDay(c.due)===date).map(c=>'<button class="calcard" style="--state-color:'+stateColor(c.state)+'" data-card="'+esc(c.id)+'">'+esc(c.id+' '+c.title)+'</button>').join('')+'</div>'}return out+'</div></div>'}
function timelineHtml(b){const cards=flatCards(b).filter(c=>isoDay(c.start)||isoDay(c.due));if(!cards.length)return '<div class="empty">No cards have a start or due date.</div>';const spans=cards.map(c=>{const s=utcDay(c.start),d=utcDay(c.due),a=s??d,z=d??s;return {c:c,start:Math.min(a,z),end:Math.max(a,z)}});let min=Math.min(...spans.map(x=>x.start)),max=Math.max(...spans.map(x=>x.end));if(min===max){min--;max++}const range=max-min+1,tick=n=>dayIso(Math.round(min+(range-1)*n));return '<div class="timeline"><div class="tlaxis"><span>'+tick(0)+'</span><span>'+tick(.25)+'</span><span>'+tick(.5)+'</span><span>'+tick(.75)+'</span><span>'+tick(1)+'</span></div>'+spans.sort((a,z)=>a.start-z.start).map(x=>'<div class="tlrow"><button class="tllabel" data-card="'+esc(x.c.id)+'"><code>'+esc(x.c.id)+'</code> '+esc(x.c.title)+'</button><div class="tltrack"><button class="tlbar" data-open-card="'+esc(x.c.id)+'" style="left:'+((x.start-min)/range*100)+'%;width:'+Math.max(100/range,(x.end-x.start+1)/range*100)+'%;--state-color:'+stateColor(x.c.state)+'" aria-label="'+esc(dayIso(x.start)+' through '+dayIso(x.end))+'"></button></div></div>').join('')+'</div>'}
function avg(values){return values.length?Math.round(values.reduce((a,n)=>a+n,0)/values.length*10)/10:null}
function metricsHtml(b){const cards=flatCards(b),active=cards.filter(c=>!['done','archive'].includes(c.state)),done=cards.filter(c=>c.state==='done'),overdue=cards.filter(c=>c.metrics&&c.metrics.due&&c.metrics.due.status==='overdue'),cycle=cards.map(c=>c.metrics&&c.metrics.cycleDays).filter(n=>n!=null),lead=cards.map(c=>c.metrics&&c.metrics.leadDays).filter(n=>n!=null),idle=active.map(c=>c.metrics&&c.metrics.idleDays).filter(n=>n!=null),throughput=(b.flow&&b.flow.throughput)||[],last7=throughput.slice(-7).reduce((n,x)=>n+x.count,0),last30=throughput.reduce((n,x)=>n+x.count,0),wip=(b.lanes||[]).filter(l=>l.wip!=null&&l.cards.length>l.wip).length,metric=(value,label)=>'<div class="metric"><b>'+esc(value)+'</b><span>'+esc(label)+'</span></div>',max=Math.max(1,...throughput.map(x=>x.count)),flow=(b.flow&&b.flow.cumulativeFlow)||[],flowMax=Math.max(1,...flow.map(x=>ORDER.reduce((n,s)=>n+(x.distribution[s]||0),0))),blockers=Object.entries((b.flow&&b.flow.blockerDays)||{}).sort((a,z)=>z[1]-a[1]),age=[0,1,2,3].map(level=>[level,active.filter(c=>(c.metrics&&c.metrics.agingLevel||0)===level).length]);return '<div class="metricgrid">'+metric(cards.length,'cards')+metric(active.length,'active')+metric((b.ready||[]).length,'ready')+metric(overdue.length,'overdue')+metric(last7,'completed · 7d')+metric(last30,'completed · 30d')+metric(avg(cycle)??'—','average cycle days')+metric(avg(lead)??'—','average lead days')+metric(avg(idle)??'—','average active idle days')+metric(wip,'WIP breaches')+metric(done.reduce((n,c)=>n+(c.estimate||0),0),'completed estimate')+'</div><div class="chartgrid"><section class="chart"><h2>throughput · 30 UTC days</h2><div class="bars" role="img" aria-label="'+esc('Daily throughput: '+(throughput.length?throughput.map(x=>x.date+' '+x.count).join(', '):'no completions'))+'">'+throughput.map(x=>'<i style="height:'+(x.count/max*100)+'%" title="'+esc(x.date+': '+x.count)+'"></i>').join('')+'</div></section><section class="chart"><h2>cumulative flow · 30 UTC days</h2><div class="cfbars" role="img" aria-label="'+esc('Cumulative flow by state for '+flow.length+' day'+(flow.length===1?'':'s'))+'">'+flow.map(x=>'<div class="cfbar" title="'+esc(x.date)+'">'+ORDER.map(s=>{const n=x.distribution[s]||0;return n?'<i style="height:'+(n/flowMax*100)+'%;background:'+stateColor(s)+'"></i>':''}).join('')+'</div>').join('')+'</div></section><section class="chart"><h2>active-card aging</h2><div class="metriclist">'+age.map(x=>'<div><span>'+(['fresh','7+ days','14+ days','28+ days'][x[0]])+'</span><b>'+x[1]+'</b></div>').join('')+'</div></section><section class="chart"><h2>blocked days by reason</h2>'+(blockers.length?'<div class="metriclist">'+blockers.map(x=>'<div><span>'+esc(x[0])+'</span><b>'+x[1]+'d</b></div>').join('')+'</div>':'<div class="empty">no proven blocked intervals</div>')+'</section></div>'}
function hillY(value){return 20+160*Math.pow((value-50)/50,2)}
function hillHtml(b){const cards=flatCards(b).filter(c=>c.type!=='board'&&!['done','archive'].includes(c.state)),plotted=cards.filter(c=>c.hill!=null);return '<div class="hillview"><p class="hillnote">Manual uncertainty, not automatic progress. Uphill is discovery; downhill is execution after the approach is understood.</p><div class="hillplot"><svg viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true"><path d="M 0 180 Q 250 20 500 20 Q 750 20 1000 180"></path></svg><i class="crest" aria-hidden="true"></i><span class="hillphase up">figuring it out · uphill</span><span class="hillphase down">making it happen · downhill</span>'+plotted.map(c=>'<span class="hilldot" style="left:'+(4+c.hill*.92)+'%;top:'+hillY(c.hill)+'px;--state-color:'+stateColor(c.state)+'" role="img" aria-label="'+esc(c.id+' '+c.title+', hill position '+c.hill)+'" title="'+esc(c.id+' '+c.title+' · '+c.hill)+'"></span>').join('')+'</div><div class="hilllegend">'+cards.map(c=>'<div class="hillitem" style="--state-color:'+stateColor(c.state)+'"><i></i><button data-card="'+esc(c.id)+'">'+esc(c.id+' '+c.title)+'</button><code>'+(c.hill==null?'unplotted':c.hill)+'</code></div>').join('')+'</div>'+(cards.length?'':'<div class="empty">no active task cards</div>')+'</div>'}
function layoutHtml(b){return LAYOUT==='table'?tableHtml(b):LAYOUT==='swimlane'?swimlaneHtml(b):LAYOUT==='calendar'?calendarHtml(b):LAYOUT==='timeline'?timelineHtml(b):LAYOUT==='grouped'?groupedHtml(b):LAYOUT==='metrics'?metricsHtml(b):LAYOUT==='hill'?hillHtml(b):kanbanHtml(b)}
function kanbanHtml(b){return b.lanes.map(lane=>{const n=lane.cards.length,wip=lane.wip!=null?'<span class="'+(n>lane.wip?'wipbad':'n')+'">'+n+'/'+lane.wip+(n>lane.wip?' WIP!':'')+'</span>':'<span class="n">'+n+'</span>',canon=lane.canonical!==lane.id?'<span class="canon">→'+lane.canonical+'</span>':'';let body='';if(lane.substates.length){for(const sub of lane.substates){const cs=lane.cards.filter(c=>c.substate===sub||(sub===lane.substates[0]&&c.substate==null));if(cs.length)body+='<div class="sub-h">· '+esc(sub)+'</div>'+cs.map(cardHtml).join('')}}else body=lane.cards.map(cardHtml).join('');if(!body)body='<div class="empty">·</div>';const estimate=lane.estimate?'<span class="n">est '+lane.estimate+'</span>':'';return '<section class="col"><h2>'+esc(lane.name)+' '+canon+' '+wip+' '+estimate+'</h2>'+body+'</section>'}).join('')}
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
  const main=$('main');main.dataset.layout=LAYOUT;main.innerHTML=layoutHtml(b);syncViewControls(b);
  if(LAYOUT==='kanban')requestAnimationFrame(()=>drawRelations(b));
  $('#findings').innerHTML=(b.findings||[]).length
    ?'<h3>findings: '+esc(CUR)+'</h3>'+(b.findings||[]).map(f=>'<div class="finding">'+(f.severity==='error'?'<b>error</b>':f.severity==='warning'?'<i>warning</i>':'info')
      +' '+esc(f.rule)+' <b style="color:var(--ink)">'+esc(f.ref)+'</b> · '+esc(f.message)+'</div>').join('')
    :'';
}
function drawRelations(b){
  const cols=$('main');if(!cols)return;
  const old=$('.relsvg',cols);if(old)old.remove();
  const nodes=new Map([...cols.querySelectorAll('[data-card]')].map(el=>[el.dataset.card,el]));
  const edges=[],seen=new Set();
  for(const lane of b.lanes||[])for(const card of lane.cards||[])for(const rel of card.relationships||[]){
    if(String(rel.target).includes('#')||!nodes.has(rel.target)||rel.source==='text')continue;
    const symmetric=rel.type==='relates';
    const key=symmetric?[card.id,rel.target].sort().join('|'):card.id+'|'+rel.type+'|'+rel.target;
    if(seen.has(key))continue;seen.add(key);edges.push({from:card.id,to:rel.target,resolved:rel.active===false});
  }
  if(!edges.length)return;
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.classList.add('relsvg');
  svg.setAttribute('width',String(cols.scrollWidth));svg.setAttribute('height',String(cols.scrollHeight));svg.setAttribute('aria-hidden','true');
  const defs=document.createElementNS(ns,'defs'),marker=document.createElementNS(ns,'marker');
  marker.setAttribute('id','viewer-rel-arrow');marker.setAttribute('viewBox','0 0 10 10');marker.setAttribute('refX','9');marker.setAttribute('refY','5');marker.setAttribute('markerWidth','5');marker.setAttribute('markerHeight','5');marker.setAttribute('orient','auto-start-reverse');
  const arrow=document.createElementNS(ns,'path');arrow.setAttribute('d','M 0 0 L 10 5 L 0 10 z');arrow.setAttribute('fill','var(--st-blocked)');marker.appendChild(arrow);defs.appendChild(marker);svg.appendChild(defs);
  const base=cols.getBoundingClientRect();
  for(const edge of edges){
    const a=nodes.get(edge.from).getBoundingClientRect(),z=nodes.get(edge.to).getBoundingClientRect();
    const left=a.left<z.left,x1=(left?a.right:a.left)-base.left+cols.scrollLeft,x2=(left?z.left:z.right)-base.left+cols.scrollLeft;
    const y1=a.top+a.height/2-base.top+cols.scrollTop,y2=z.top+z.height/2-base.top+cols.scrollTop,curve=Math.max(28,Math.abs(x2-x1)*.42);
    const path=document.createElementNS(ns,'path');path.setAttribute('d','M '+x1+' '+y1+' C '+(x1+(left?curve:-curve))+' '+y1+', '+(x2+(left?-curve:curve))+' '+y2+', '+x2+' '+y2);
    path.setAttribute('marker-end','url(#viewer-rel-arrow)');if(edge.resolved)path.classList.add('resolved');svg.appendChild(path);
  }
  cols.prepend(svg);
}
window.addEventListener('resize',()=>{const b=DATA&&DATA.boards&&DATA.boards[CUR];if(b&&LAYOUT==='kanban')drawRelations(b)});
function trapDrawerTab(e,drawer){
  if(e.key!=='Tab')return;
  const f=[...drawer.querySelectorAll('button,[href],[tabindex]:not([tabindex="-1"])')].filter(x=>!x.disabled);
  if(!f.length)return;
  const first=f[0],last=f[f.length-1];
  if(e.shiftKey&&document.activeElement===first){last.focus();e.preventDefault()}
  else if(!e.shiftKey&&(document.activeElement===last||!drawer.contains(document.activeElement))){first.focus();e.preventDefault()}
}
function closeDrawer(){
  const d=$('#drawer');if(!d.classList.contains('open'))return;
  d.classList.remove('open');d.setAttribute('aria-hidden','true');
  for(const el of document.querySelectorAll('header,main,footer'))el.inert=false;
  const back=d._restoreFocus;d._restoreFocus=null;if(back&&back.focus&&document.contains(back))back.focus();
}
function openDrawer(c,opener){
  const d=$('#drawer');
  const rows=[['position',c.position],['state',c.state],['assignee',c.assignee],['delegate',c.delegate],['priority',c.priority],
    ['start',c.start],['due',c.due],['estimate',c.estimate],['hill',c.hill],['evergreen',c.evergreen?'yes':null],
    ['labels',(c.labels||[]).join(', ')],['deps',(c.deps||[]).join(', ')],['blocked',c.blocked],
    ['watchers',(c.watchers||[]).map(x=>'@'+x).join(', ')],['votes',(c.votes||[]).map(x=>'@'+x).join(', ')],
    ['mentions',(c.mentions||[]).map(x=>'@'+x).join(', ')],['boosts',c.boostCount||null],
    ...(c.fields||[]).map(f=>[f.name,fieldText(f.value)]),
    ['current lane',c.metrics&&c.metrics.currentLaneDays!=null?c.metrics.currentLaneDays+'d':null],
    ['cumulative lane',c.metrics&&c.metrics.cumulativeLaneDays!=null?c.metrics.cumulativeLaneDays+'d':null],
    ['idle',c.metrics&&c.metrics.idleDays!=null?c.metrics.idleDays+'d':null],
    ['cycle',c.metrics&&c.metrics.cycleDays!=null?c.metrics.cycleDays+'d':null],
    ['lead',c.metrics&&c.metrics.leadDays!=null?c.metrics.leadDays+'d':null],
    ['blocked time',c.metrics&&c.metrics.blockedDays?c.metrics.blockedDays+'d':null],
    ['created',c.created],['updated',c.updated],['board',c.board],['file',c.file]]
    .filter(r=>r[1]!==null&&r[1]!==undefined&&r[1]!=='');
  d._restoreFocus=opener||document.activeElement;
  d.innerHTML='<button class="close" type="button" aria-label="close card details">✕</button>'
    +'<div class="cid">'+esc(c.id)+'</div><h2 id="drawer-title">'+esc(c.title)+'</h2>'
    +'<span class="statechip" style="background:'+stateColor(c.state)+'">'+c.state+'</span>'
    +'<table>'+rows.map(r=>'<tr><td>'+esc(r[0])+'</td><td>'+esc(r[1])+'</td></tr>').join('')+'</table>'
    +'<h3>relationships</h3>'+((c.relationships||[]).length?'<div class="relations">'+c.relationships.map(r=>'<div class="relation"><span class="rtype">'+esc(r.type)+'</span><span>'+esc(r.target)+'</span><span class="rsrc">'+esc(r.source||'stored')+(r.active===false?' · resolved':'')+'</span></div>').join('')+'</div>':'<div class="empty">no linked cards</div>')
    +'<div class="body">'+(c.body&&c.body.trim()?md(c.body):'<p class="empty">no body</p>')+'</div>';
  d.setAttribute('aria-hidden','false');d.classList.add('open');
  for(const el of document.querySelectorAll('header,main,footer'))el.inert=true;
  $('.close',d).onclick=closeDrawer;$('.close',d).focus();
}
document.addEventListener('click',e=>{
  const sort=e.target.closest('[data-sort]');if(sort){if(TABLE_SORT===sort.dataset.sort)TABLE_DESC=!TABLE_DESC;else{TABLE_SORT=sort.dataset.sort;TABLE_DESC=false}render();return}
  const cal=e.target.closest('[data-cal]');if(cal){const now=new Date();if(cal.dataset.cal==='today')CAL_MONTH=now.toISOString().slice(0,7);else{const p=(CAL_MONTH||now.toISOString().slice(0,7)).split('-').map(Number),d=new Date(Date.UTC(p[0],p[1]-1+Number(cal.dataset.cal),1));CAL_MONTH=d.toISOString().slice(0,7)}render();return}
  const go=e.target.closest('[data-goto]');
  if(go&&!go.disabled){CUR=go.dataset.goto;render();e.stopPropagation();return}
  const el=e.target.closest('[data-card],[data-open-card]');
  if(el){const id=el.dataset.card||el.dataset.openCard,b=DATA.boards[CUR];for(const lane of b.lanes){const c=lane.cards.find(x=>x.id===id);if(c){openDrawer(c,el);return}}}
});
document.addEventListener('keydown',e=>{
  const drawer=$('#drawer');
  if(drawer.classList.contains('open')){
    if(e.key==='Escape'){e.preventDefault();closeDrawer();return}
    trapDrawerTab(e,drawer);
    return;
  }
  const target=e.target.closest('[data-card],[data-open-card]');
  if((e.key==='Enter'||e.key===' ')&&target&&!['BUTTON','A'].includes(e.target.tagName)){e.preventDefault();target.click()}
});
$('#switch').addEventListener('change',e=>{CUR=e.target.value;render()});
$('#layout').addEventListener('change',e=>{LAYOUT=e.target.value;localStorage.setItem('bfv_layout',LAYOUT);render()});
$('#axis').addEventListener('change',e=>{if(LAYOUT==='grouped'){GROUP_AXIS=e.target.value;localStorage.setItem('bfv_group_axis',GROUP_AXIS)}else{SWIM_AXIS=e.target.value;localStorage.setItem('bfv_swim_axis',SWIM_AXIS)}render()});
$('#tstyle').innerHTML=THEMES.map(s=>'<option value="'+s.id+'">'+esc(s.name)+'</option>').join('');
$('#tstyle').addEventListener('change',e=>{THEME.style=e.target.value;THEME.accent=null;saveTheme()});
$('#taccent').addEventListener('change',e=>{THEME.accent=e.target.value;saveTheme()});
$('#tmode').addEventListener('click',()=>{THEME.mode=THEME.mode==='system'?'light':THEME.mode==='light'?'dark':'system';saveTheme()});
$('#taglimit').addEventListener('change',e=>{CARD_TAG_LIMIT=Number(e.target.value);localStorage.setItem('bfv_card_tag_limit',String(CARD_TAG_LIMIT));render()});
applyTheme();
async function poll(){
  try{const r=await fetch('api/data');const next=await r.text();
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'">
<meta name="referrer" content="no-referrer">
<title>${escHtml(opts.title ?? 'botflow')}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1><span id="title">botflow</span> <span class="sub" id="sub"></span></h1>
  <select id="switch" style="display:none" aria-label="board"></select>
  <div class="meter" title="structural progress: every card is one unit; a sub-board fills its unit by its own fraction"><span class="lbl">progress</span><div class="track"><div class="fill" id="pfill" style="width:0"></div></div><span class="num" id="pnum">·</span></div>
  <div class="dist"><div class="strip" id="strip" role="img" aria-label="cards by state"></div><div class="chips" id="chips"></div></div>
  <div class="lintchips" id="lint"></div>
  <div class="viewctl"><select id="layout" aria-label="board view">
    <option value="kanban">board</option><option value="table">table</option><option value="swimlane">swimlanes</option><option value="calendar">calendar</option><option value="timeline">timeline</option><option value="grouped">group by field</option><option value="metrics">metrics</option><option value="hill">hill chart</option>
  </select><select id="axis" aria-label="grouping axis" hidden></select></div>
  <div class="themectl"><span class="lbl">paint</span>
    <select id="tstyle" aria-label="visual style"></select>
    <select id="taccent" aria-label="accent"></select>
    <button id="tmode" aria-label="color mode" title="cycle system, light, dark">auto</button>
    <span class="lbl">tags</span><select id="taglimit" aria-label="visible tags per card">
      ${Array.from({ length: MAX_CARD_TAG_LIMIT + 1 }, (_, value) => `<option value="${value}">${value === 0 ? 'none' : value}</option>`).join('')}
    </select>
  </div>
</header>
<main></main>
<footer id="findings"></footer>
<div id="drawer" role="dialog" aria-modal="true" aria-hidden="true" aria-labelledby="drawer-title" tabindex="-1"></div>
<script>window.__BOTFLOW__=${payload};window.__LIVE__=${opts.live};window.__THEMES__=${JSON.stringify(STYLES)};</script>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}
