// The operator web app, served at "/". One self-contained page, zero deps.
// Structure is one stylesheet driven entirely by CSS variables; the five
// styles in themes.ts repaint and reshape it (radius, borders, shadows, font)
// without touching markup. Cards open into a large tabbed modal (details,
// chat, activity) with checklists, attachments, galleries, and cover art,
// all stored in the card's markdown body (file-format truth).

import { DEFAULT_CARD_TAG_LIMIT, MAX_CARD_TAG_LIMIT } from '../../src/ui/card-face.ts';
import { STYLES } from './themes.ts';

const CSS = `
*{box-sizing:border-box;margin:0}
:root{--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;
  --surface2:#f1f1ed;--grid:#e1e0d9;--baseline:#c3c2b7;--ring:rgba(11,11,11,.10);--acc:#2a78d6;--acc-ink:#fff;
  --st-wishlist:#c3c2b7;--st-todo:#898781;--st-blocked:#d03b3b;--st-doing:#2a78d6;--st-done:#0ca30c;--st-archive:#e1e0d9;
  --rc:10px;--rk:6px;--bw:1px;--bs:solid;--shadow:0 1px 3px rgba(0,0,0,.06);
  --font:system-ui,-apple-system,"Segoe UI",sans-serif;--display:var(--font);
  --base-size:14px;--line-height:1.45;--header-pad:12px 18px;--side-w:280px;--side-pad:14px;
  --pane-head-pad:12px 18px;--view-pad:14px 18px;--col-w:258px;--col-gap:12px;--col-pad:9px;
  --card-gap:7px;--card-pad:7px 10px 8px;--control-pad:4px 11px;--field-pad:6px 9px;--art-h:92px}
#burger{display:none}
body{background-color:var(--page);color:var(--ink);font:var(--base-size)/var(--line-height) var(--font);height:100vh;display:flex;flex-direction:column}
button{font:inherit;color:var(--ink);background:var(--surface);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rk);padding:var(--control-pad);cursor:pointer}
button:hover{border-color:var(--baseline)}
button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
button.primary{background:var(--acc);color:var(--acc-ink);border-color:transparent}
button.ghost{border-color:transparent;background:none;color:var(--muted)}
button.ghost:hover{color:var(--ink)}
input,textarea,select{font:inherit;color:var(--ink);background:var(--surface);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rk);padding:var(--field-pad)}
svg.ic{width:13px;height:13px;vertical-align:-2px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
header.top{display:flex;align-items:center;gap:18px;padding:var(--header-pad);border-bottom:var(--bw) var(--bs) var(--grid);flex:none;background:var(--surface)}
header.top h1{font:700 16px/1.1 var(--display)}
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
aside{width:var(--side-w);flex:none;border-right:var(--bw) var(--bs) var(--grid);overflow-y:auto;padding:var(--side-pad);display:flex;flex-direction:column}
aside h2{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:14px 0 6px;display:flex;align-items:center}
aside h2 button{font-size:11px;padding:1px 7px;margin-left:auto}
.row{display:flex;align-items:center;gap:7px;padding:5px 7px;border-radius:var(--rk);cursor:pointer;font-size:13px}
.row:hover{background:var(--surface2)}
.row.sel{background:var(--surface2);outline:var(--bw) var(--bs) var(--grid)}
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
.phead{display:flex;align-items:center;gap:16px;padding:var(--pane-head-pad);border-bottom:var(--bw) var(--bs) var(--grid);flex-wrap:wrap;background:color-mix(in srgb,var(--surface) 86%,transparent)}
.phead h2{font:700 15px/1.15 var(--display)}
.shot .src{position:absolute;left:6px;bottom:6px;background:var(--ink);color:var(--page);opacity:.85;
  font-size:10px;padding:1px 7px;border-radius:999px;max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badges .by{opacity:.75;font-style:italic}
.whoami{font-size:11.5px;color:var(--muted);margin-right:10px;white-space:nowrap}
.whoami i{font-style:normal;text-transform:uppercase;letter-spacing:.05em;font-size:9.5px;opacity:.7;border:var(--bw) var(--bs) var(--grid);border-radius:999px;padding:1px 5px;margin-left:4px}
/* ---- drag to move ---- */
.deck{display:flex;flex-direction:column;gap:var(--card-gap);min-height:24px}
.subgroup{display:flex;flex-direction:column;gap:var(--card-gap)}
.dragging{opacity:.35;filter:saturate(.4)}
.dragghost{position:fixed;z-index:70;pointer-events:none;margin:0;
  transform:translate(-50%,-50%) rotate(1.5deg);box-shadow:0 18px 40px rgba(0,0,0,.28);opacity:.95}
/* While a card is in the air the board says where it may land: legal targets
   lift, illegal ones recede. Nothing is left to a post-drop error message. */
.dragmode .col{transition:background .12s ease,border-color .12s ease}
.dragmode .col.nodrop{opacity:.45}
.dragmode .col.candrop{border-color:var(--acc)}
.dragmode .drop-on{background:color-mix(in srgb,var(--acc) 12%,var(--surface))}
.dragmode .subgroup{border-radius:var(--rk);outline:1px dashed transparent;outline-offset:2px}
.dragmode .subgroup.candrop{outline-color:var(--grid)}
.dragmode .subgroup.drop-on{outline-color:var(--acc);background:color-mix(in srgb,var(--acc) 12%,var(--surface))}
.dragmode .subgroup.nodrop{opacity:.4}
/* Owner-only: dropping somewhere the lane's own rules forbid is an override,
   and it should not look like an ordinary drop. */
.dragmode .drop-force{background:color-mix(in srgb,var(--st-blocked) 16%,var(--surface));outline-color:var(--st-blocked)}
.dragmode .col.drop-force{border-color:var(--st-blocked)}
.wormrail{display:none;position:sticky;left:0;bottom:8px;z-index:69;align-items:center;gap:8px;margin:14px 0 0;padding:8px;border:1px dashed var(--grid);border-radius:var(--rc);background:color-mix(in srgb,var(--surface) 92%,transparent);box-shadow:var(--shadow)}
.dragmode .wormrail{display:flex}.wormrail .lbl{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em}.wormhole{border:var(--bw) var(--bs) var(--grid);border-radius:999px;padding:5px 10px;background:var(--surface2);color:var(--ink2);font-size:12px}.wormhole.candrop{border-color:var(--acc)}.wormhole.drop-on{background:var(--acc);color:var(--acc-ink);transform:scale(1.04)}
.draghint{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:71;pointer-events:none;
  background:var(--ink);color:var(--page);font-size:12px;padding:6px 12px;border-radius:999px;box-shadow:var(--shadow);opacity:.92}
.card{touch-action:pan-y}
.tabs{display:flex;gap:2px;margin-left:auto}
.tabs button.on{background:var(--acc);color:var(--acc-ink);border-color:transparent}
.searchbox{display:flex;align-items:center;gap:5px;min-width:260px}
.searchbox input{width:min(260px,28vw)}
.searchbox select{max-width:180px}
.searchstatus{font-size:11px;color:var(--muted);white-space:nowrap}
.view{flex:1;overflow:auto;padding:var(--view-pad)}
.viewctl{display:flex;align-items:center;gap:5px}
.viewctl select{max-width:150px;padding:3px 7px;font-size:12px}
.viewctl .axisctl[hidden]{display:none}
.cols{display:flex;gap:var(--col-gap);align-items:flex-start;position:relative}
.relsvg{position:absolute;inset:0;overflow:visible;pointer-events:none;z-index:4}
.relsvg path{fill:none;stroke:var(--st-blocked);stroke-width:2;opacity:.58;vector-effect:non-scaling-stroke}
.relsvg path.resolved{stroke:var(--muted);stroke-dasharray:4 4;opacity:.4}
.card{position:relative;z-index:5}
.col{background:var(--surface);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);min-width:var(--col-w);width:var(--col-w);flex:none;padding:var(--col-pad);box-shadow:var(--shadow)}
.col h3{font:700 11px/1.25 var(--display);text-transform:uppercase;letter-spacing:.04em;color:var(--ink2);padding:2px 4px 7px;display:flex;gap:6px}
.col h3 .n{color:var(--muted);font-weight:400}
.col h3 .wipbad{color:var(--st-blocked)}
.col h3 .wipmode{font-size:9px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.lanefoot{display:flex;align-items:center;gap:5px;margin-top:7px;padding-top:7px;border-top:1px dashed transparent;opacity:0;transform:translateY(-2px);pointer-events:none;transition:opacity .12s ease,transform .12s ease,border-color .12s ease}
.laneadd{flex:1;text-align:left;background:transparent;border-color:transparent;color:var(--muted);padding:4px 7px}
.lanesub{flex:none;background:transparent;border-color:transparent;color:var(--muted);padding:4px 7px}
.laneadd:hover,.laneadd:focus-visible,.lanesub:hover,.lanesub:focus-visible{color:var(--ink);border-color:var(--grid);background:var(--surface2)}
.lanesub[aria-pressed="true"]{color:var(--acc);border-color:color-mix(in srgb,var(--acc) 45%,var(--grid))}
.col:hover .lanefoot,.col:focus-within .lanefoot{opacity:1;transform:none;pointer-events:auto;border-top-color:var(--grid)}
.sub-h{font-size:11px;color:var(--muted);padding:5px 4px 2px;border-top:1px dashed var(--grid);margin-top:5px}
.card{border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);margin:var(--card-gap) 0;background:var(--surface);cursor:pointer;overflow:hidden;transition:transform .14s ease,box-shadow .14s ease,border-color .14s ease}
.card:hover{border-color:var(--baseline)}
.card:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
.card.blocked{border-left:3px solid var(--st-blocked)}
.card.namedblocked{cursor:not-allowed}
.card.has-color::before{content:"";display:block;height:5px;background:var(--cover-color)}
.card.age-1:not(:hover):not(:focus-within){opacity:.9}
.card.age-2:not(:hover):not(:focus-within){opacity:.8}
.card.age-3:not(:hover):not(:focus-within){opacity:.68;filter:saturate(.65)}
.card .art{width:100%;height:var(--art-h);object-fit:cover;display:block;border-bottom:var(--bw) var(--bs) var(--grid)}
.card .inner{padding:var(--card-pad)}
.card .cid{font:11px ui-monospace,Menlo,monospace;color:var(--muted)}
.card .t{font-weight:550;margin:1px 0 5px}
.badges{display:flex;flex-wrap:wrap;gap:5px;font-size:11px;color:var(--ink2);align-items:center}
.badges span{border:var(--bw) var(--bs) var(--grid);border-radius:999px;padding:1px 7px;background:var(--surface);display:inline-flex;gap:4px;align-items:center}
.badges .bare{border:none;background:none;padding:1px 2px}
.badges .ready{color:var(--st-done);font-weight:650}
.badges .p0{color:var(--st-blocked);font-weight:650}
.badges .p1{color:#c47317;font-weight:650}
.badges .blk{color:var(--st-blocked)}
.badges .namedblk{color:var(--blocker-color,var(--st-blocked));font-weight:650}
.badges .snoozed{color:var(--muted)}
.badges .ok{color:var(--st-done)}
.badges .due-overdue,.badges .due-today{color:var(--st-blocked);font-weight:650}
.badges .due-soon{color:#c47317;font-weight:650}
.badges .lbl{box-shadow:inset 3px 0 0 var(--lc)}
.badges .moretags{color:var(--muted);border-style:dashed}
.badges .fieldface b{font-weight:600;color:var(--muted)}
.previewtasks{margin-top:6px;padding-top:5px;border-top:1px dashed var(--grid);font-size:11px;color:var(--ink2);display:flex;flex-direction:column;gap:2px}
.previewtasks span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.previewtasks span::before{content:"□ ";color:var(--muted)}
.subboard{margin:7px 0 0;display:flex;gap:8px;align-items:center}
.subboard button{font-size:12px;padding:2px 8px}
.subboard .mini{flex:1;height:6px;border-radius:3px;background:var(--grid);overflow:hidden}
.subboard .mini i{display:block;height:100%;background:var(--acc)}
.empty{color:var(--muted);font-size:12px;padding:6px 4px}
table.list{border-collapse:collapse;width:100%;font-size:13px}
table.list td,table.list th{text-align:left;padding:6px 10px;border-bottom:var(--bw) var(--bs) var(--grid)}
table.list th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
table.list td.mono{font:12px ui-monospace,Menlo,monospace;color:var(--ink2)}
.cardtable{overflow:auto;margin-top:12px;border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);background:var(--surface)}
.cardtable table{min-width:1000px}
.cardtable tr[data-card]{cursor:pointer}.cardtable tr[data-card]:hover{background:var(--surface2)}.cardtable tr[data-card]:focus-visible{outline:2px solid var(--acc);outline-offset:-2px;background:var(--surface2)}
.cardtable th button{border:0;background:none;padding:0;color:inherit;text-transform:inherit;letter-spacing:inherit;font:inherit}
.cardtable .titlecell{font-weight:600;min-width:220px}.cardtable .labels-cell{max-width:250px;color:var(--ink2)}
.axiscols{display:flex;gap:var(--col-gap);align-items:flex-start;margin-top:12px;min-height:160px}
.axiscol{background:var(--surface);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);width:var(--col-w);min-width:var(--col-w);padding:var(--col-pad);box-shadow:var(--shadow)}
.axiscol h3{font:700 11px/1.25 var(--display);text-transform:uppercase;letter-spacing:.04em;color:var(--ink2);padding:2px 4px 7px;display:flex;gap:6px}.axiscol h3 .n{font-weight:400;color:var(--muted)}
.dragmode .axiscol.candrop{border-color:var(--acc)}.dragmode .axiscol.drop-on{background:color-mix(in srgb,var(--acc) 12%,var(--surface))}
.swimwrap{overflow:auto;margin-top:12px;border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);background:var(--surface)}
.swim{display:grid;min-width:max-content}.swimhead,.swimlabel,.swimcell{padding:8px;border-right:var(--bw) var(--bs) var(--grid);border-bottom:var(--bw) var(--bs) var(--grid)}
.swimhead{position:sticky;top:0;z-index:6;background:var(--surface2);font:700 11px/1.2 var(--display);text-transform:uppercase;letter-spacing:.04em;color:var(--ink2);min-width:220px}
.swimlabel{position:sticky;left:0;z-index:5;background:var(--surface2);font-weight:650;min-width:150px}.swimlabel small{display:block;color:var(--muted);font-weight:400}
.swimcell{width:240px;min-height:74px;background:var(--surface)}.swimcell .card{margin:0 0 6px}
.calendar{margin-top:12px}.calbar{display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:8px}.calbar h3{font:700 14px var(--display);min-width:170px;text-align:center}
.calgrid{display:grid;grid-template-columns:repeat(7,minmax(120px,1fr));border-top:var(--bw) var(--bs) var(--grid);border-left:var(--bw) var(--bs) var(--grid);min-width:840px;background:var(--surface)}
.caldayname{padding:5px 7px;background:var(--surface2);font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);border-right:var(--bw) var(--bs) var(--grid);border-bottom:var(--bw) var(--bs) var(--grid)}
.calday{min-height:112px;padding:5px;border-right:var(--bw) var(--bs) var(--grid);border-bottom:var(--bw) var(--bs) var(--grid)}.calday.out{background:var(--page);opacity:.62}.calday.today{box-shadow:inset 0 0 0 2px var(--acc)}
.caldate{font:11px ui-monospace,Menlo,monospace;color:var(--muted);margin:0 2px 5px}.calcard{display:block;width:100%;text-align:left;border:0;border-left:3px solid var(--state-color);background:var(--surface2);padding:3px 5px;margin:3px 0;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.timeline{margin-top:12px;min-width:760px}.tlaxis{margin-left:230px;display:flex;justify-content:space-between;color:var(--muted);font:10px ui-monospace,Menlo,monospace;padding:0 2px 5px}.tlrow{display:grid;grid-template-columns:220px minmax(520px,1fr);gap:10px;align-items:center;min-height:38px}.tllabel{border:0;background:none;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px;color:var(--ink)}.tllabel code{font-size:10px;color:var(--muted)}
.tltrack{height:24px;position:relative;border-left:var(--bw) var(--bs) var(--grid);border-right:var(--bw) var(--bs) var(--grid);background:repeating-linear-gradient(90deg,var(--surface2) 0,var(--surface2) 1px,transparent 1px,transparent 10%)}.tlbar{position:absolute;top:4px;height:16px;min-width:5px;border-radius:999px;background:var(--state-color);box-shadow:var(--shadow)}
.metricgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:12px}.metric{background:var(--surface);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);padding:13px;box-shadow:var(--shadow)}.metric b{font:700 22px/1 var(--display);display:block}.metric span{font-size:11px;color:var(--muted)}
.chartgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px;margin-top:12px}.chart{background:var(--surface);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);padding:12px;min-width:0}.chart h3{font:700 12px var(--display);margin-bottom:8px}.bars{height:150px;display:flex;align-items:flex-end;gap:3px;border-bottom:var(--bw) var(--bs) var(--grid)}.bars i{flex:1;min-width:2px;background:var(--acc);border-radius:2px 2px 0 0}.cfbars{height:150px;display:flex;gap:2px;align-items:flex-end}.cfbar{flex:1;display:flex;flex-direction:column-reverse;height:100%}.cfbar i{display:block;min-height:1px}
.metriclist{display:grid;gap:5px;font-size:12px}.metriclist div{display:flex;gap:10px}.metriclist b{margin-left:auto}
.hillview{margin-top:12px;background:var(--surface);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);padding:14px;box-shadow:var(--shadow)}.hillnote{color:var(--muted);font-size:12px;margin-bottom:8px}.hillplot{height:270px;position:relative;overflow:hidden;border-bottom:var(--bw) var(--bs) var(--grid);touch-action:none}.hillplot svg{position:absolute;inset:18px 4% 34px;width:92%;height:200px;overflow:visible}.hillplot path{fill:none;stroke:var(--grid);stroke-width:5;vector-effect:non-scaling-stroke}.hillplot .crest{position:absolute;left:50%;top:17px;bottom:34px;border-left:1px dashed var(--grid)}.hillphase{position:absolute;bottom:8px;color:var(--muted);font-size:11px}.hillphase.up{left:10%}.hillphase.down{right:10%}.hilldot{position:absolute;z-index:3;width:20px;height:20px;padding:0;border-radius:50%;transform:translate(-50%,-50%);background:var(--state-color);border:3px solid var(--surface);box-shadow:0 1px 5px rgba(0,0,0,.3)}.hilldot:focus-visible{outline:3px solid var(--acc);outline-offset:2px}.hilllegend{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:6px;margin-top:10px}.hillitem{display:flex;align-items:center;gap:7px;font-size:12px}.hillitem i{width:9px;height:9px;border-radius:50%;background:var(--state-color);flex:none}.hillitem button{border:0;background:none;padding:2px;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hillitem code{margin-left:auto;color:var(--muted);font-size:10px}.hillitem .hillset{margin-left:auto;border:var(--bw) var(--bs) var(--grid);border-radius:999px;padding:2px 7px;color:var(--muted);font-size:10px;flex:none}.hillitem .hillset:hover{color:var(--ink);border-color:var(--acc)}
.err{color:var(--st-blocked);font-size:13px;margin-top:8px}
.warn{color:#c47317;font-size:12px}
.tokenbox{font:12px ui-monospace,Menlo,monospace;background:var(--page);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rk);padding:10px;word-break:break-all;margin:10px 0}
.feedurls{display:grid;gap:4px;min-width:260px}.feedurls a{color:var(--acc);word-break:break-all}.feedurls button{justify-self:start}
.gate{max-width:430px;margin:10vh auto;background:var(--surface);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);padding:26px;box-shadow:var(--shadow)}
.gate h2{margin-bottom:8px;font-family:var(--display)}
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
.pubcard #pcbox{max-width:780px}
.pubcard .cardmodal .close{display:none}
.pubfoot a{color:var(--muted);text-decoration:underline;text-underline-offset:2px}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:flex-start;justify-content:center;padding:5vh 16px;z-index:20;overflow-y:auto}
.modal{background:var(--surface);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);box-shadow:var(--shadow);width:100%;max-width:400px;padding:20px}
.modal h3{margin-bottom:12px;font:700 15px/1.2 var(--display)}
.modal .field{margin-bottom:10px}
.modal .field label{display:block;font-size:12px;color:var(--ink2);margin-bottom:3px}
.modal .field input,.modal .field textarea,.modal .field select{width:100%;margin-top:3px}
.modal .field textarea{resize:vertical;font:12.5px/1.5 ui-monospace,Menlo,monospace}
.editor{max-width:680px}
.lanerow{display:flex;gap:6px;align-items:center;margin:5px 0;flex-wrap:wrap}
.lanerow input,.lanerow select{padding:3px 7px;font-size:12.5px}
.lanerow .lid{width:110px}
.lanerow .lsub{flex:1;min-width:120px}
.lanerow .lwip{width:52px}
.lanerow.dead{opacity:.55}
.lanerow.dead .lid{text-decoration:line-through}
.lanerow .mig{display:inline-flex;gap:5px;align-items:center;font-size:11.5px;color:var(--st-blocked)}
.lanerow .mig[hidden]{display:none}
.registryrow{display:flex;gap:6px;align-items:center;margin:5px 0;flex-wrap:wrap}
.registryrow input,.registryrow select{padding:3px 7px;font-size:12.5px}
.registryrow .rid{width:145px}.registryrow .rname{width:120px}.registryrow .ropts{flex:1;min-width:130px}.registryrow .rcolor{width:105px}
.registryrow .rwide{flex:1;min-width:150px}
.registryrow .rface{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:var(--ink2)}
.registryrow .rface input{width:auto;margin:0}
.templaterow{border:var(--bw) var(--bs) var(--grid);border-radius:var(--rk);padding:8px;margin:6px 0;background:var(--page)}
.templaterow summary{cursor:pointer;font-size:12px;color:var(--ink2)}
.templaterow .templategrid{display:grid;grid-template-columns:repeat(3,minmax(120px,1fr));gap:6px;margin-top:8px}
.templaterow input,.templaterow select,.templaterow textarea{width:100%;font-size:12px;padding:4px 6px}
.templaterow textarea{grid-column:1/-1;min-height:62px;font-family:ui-monospace,Menlo,monospace}
.relations{display:flex;flex-direction:column;gap:5px}
.relation{display:flex;gap:8px;align-items:center;padding:5px 8px;border:var(--bw) var(--bs) var(--grid);border-radius:var(--rk);font-size:12px;background:var(--page)}
.relation .rtype{font-weight:650;color:var(--ink2)}
.relation .rsrc{color:var(--muted);margin-left:auto}
.relation button{font-size:10px;padding:1px 6px}
.promote{margin-left:auto!important;font-size:10px!important;opacity:.72}
.cl .item:hover .promote{opacity:1}
.editor h4{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:14px 0 6px}
.editor .rollups{display:flex;gap:14px;flex-wrap:wrap;font-size:12.5px}
.editor .rollups label{display:flex;flex-direction:column;gap:3px;color:var(--ink2)}
.modal .actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
.cardmodal{max-width:780px;padding:0;overflow:hidden}
.cardmodal .banner{width:100%;height:170px;object-fit:cover;display:block}
.cardmodal .coverband{height:8px;background:var(--cover-color)}
.cardmodal .inner{padding:18px 22px 22px}
.cardmodal .close{float:right;font-size:16px;padding:2px 9px}
.cardmodal .cid{font:12px ui-monospace,Menlo,monospace;color:var(--muted)}
.cardmodal h2{font:700 18px/1.25 var(--display);margin:2px 0 8px}
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

/* Harbor: translucent, calm, and dimensional. */
html[data-style="harbor"] body{background-image:
  radial-gradient(circle at 5% 0%,color-mix(in srgb,var(--acc) 16%,transparent) 0,transparent 30%),
  radial-gradient(circle at 95% 4%,color-mix(in srgb,var(--surface2) 82%,transparent) 0,transparent 28%);background-attachment:fixed}
html[data-style="harbor"] header.top,html[data-style="harbor"] aside,html[data-style="harbor"] .phead{background:color-mix(in srgb,var(--surface) 86%,transparent);backdrop-filter:blur(16px)}
html[data-style="harbor"] .col{background:color-mix(in srgb,var(--surface) 82%,transparent);border-color:color-mix(in srgb,var(--grid) 72%,transparent)}
html[data-style="harbor"] .card{border-color:color-mix(in srgb,var(--grid) 76%,transparent);box-shadow:inset 0 3px 0 color-mix(in srgb,var(--acc) 38%,transparent),0 3px 12px color-mix(in srgb,var(--ink) 7%,transparent)}
html[data-style="harbor"] .card:hover{transform:translateY(-2px);box-shadow:inset 0 3px 0 var(--acc),0 8px 20px color-mix(in srgb,var(--ink) 12%,transparent)}
html[data-style="harbor"] .row.sel{outline:none;box-shadow:inset 3px 0 0 var(--acc)}

/* Phosphor: a working terminal, including grid, prompts, and signal glow. */
html[data-style="phosphor"] body{background-image:
  linear-gradient(color-mix(in srgb,var(--acc) 7%,transparent) 1px,transparent 1px),
  linear-gradient(90deg,color-mix(in srgb,var(--acc) 7%,transparent) 1px,transparent 1px);background-size:24px 24px;background-attachment:fixed}
html[data-style="phosphor"] header.top,html[data-style="phosphor"] aside,html[data-style="phosphor"] .phead{background:var(--surface)}
html[data-style="phosphor"] header.top h1::before{content:">_ ";color:var(--acc)}
html[data-style="phosphor"] aside h2::before,html[data-style="phosphor"] .col h3::before{content:"//";color:var(--acc)}
html[data-style="phosphor"] .phead h2,html[data-style="phosphor"] header.top h1{letter-spacing:.04em;text-transform:uppercase}
html[data-style="phosphor"] .col{background:color-mix(in srgb,var(--surface) 94%,transparent)}
html[data-style="phosphor"] .card{background:var(--page);border-left:2px solid var(--acc)}
html[data-style="phosphor"] .card:hover{background:var(--surface2);box-shadow:inset 0 0 0 1px var(--acc)}
html[data-style="phosphor"] button.primary{box-shadow:0 0 16px color-mix(in srgb,var(--acc) 38%,transparent)}
html[data-style="phosphor"] .statechip,html[data-style="phosphor"] .badges span,html[data-style="phosphor"] .meter .track,html[data-style="phosphor"] .strip{border-radius:0}
html[data-style="phosphor"] .card .t{font-weight:600;letter-spacing:-.02em}

/* Field Notes: an editorial notebook, not a beige software theme. */
html[data-style="fieldnotes"] body{background-image:repeating-linear-gradient(to bottom,transparent 0,transparent 31px,color-mix(in srgb,var(--baseline) 22%,transparent) 32px);background-attachment:local}
html[data-style="fieldnotes"] header.top,html[data-style="fieldnotes"] aside,html[data-style="fieldnotes"] .phead{background:color-mix(in srgb,var(--surface) 92%,transparent)}
html[data-style="fieldnotes"] header.top h1{font-style:italic;letter-spacing:-.025em}
html[data-style="fieldnotes"] button,html[data-style="fieldnotes"] input,html[data-style="fieldnotes"] textarea,html[data-style="fieldnotes"] .statechip,html[data-style="fieldnotes"] .badges,html[data-style="fieldnotes"] aside h2,html[data-style="fieldnotes"] .col h3{font-family:ui-monospace,"SF Mono",Menlo,monospace}
html[data-style="fieldnotes"] .col{border-top:3px double var(--ink)}
html[data-style="fieldnotes"] .card:not(.blocked){border-left:3px double var(--acc)}
html[data-style="fieldnotes"] .card{box-shadow:1px 2px 0 color-mix(in srgb,var(--ink) 18%,transparent)}
html[data-style="fieldnotes"] .col .card:nth-child(3n+2){transform:rotate(.18deg)}
html[data-style="fieldnotes"] .card:hover{transform:translateY(-1px) rotate(0);box-shadow:2px 4px 0 color-mix(in srgb,var(--ink) 20%,transparent)}
html[data-style="fieldnotes"] .col h3{border-bottom:1px solid var(--baseline)}

/* Mochi: soft bento trays, candy light, and generous rounded objects. */
html[data-style="mochi"] body{background-image:
  radial-gradient(circle at 8% 2%,color-mix(in srgb,var(--acc) 17%,transparent) 0,transparent 25%),
  radial-gradient(circle at 86% 12%,color-mix(in srgb,var(--surface2) 88%,transparent) 0,transparent 30%);background-attachment:fixed}
html[data-style="mochi"] header.top,html[data-style="mochi"] aside,html[data-style="mochi"] .phead{background:color-mix(in srgb,var(--surface) 88%,transparent);backdrop-filter:blur(14px)}
html[data-style="mochi"] .col{border-color:transparent;background:linear-gradient(180deg,color-mix(in srgb,var(--surface2) 68%,var(--surface)),var(--surface))}
html[data-style="mochi"] .card{border-color:color-mix(in srgb,var(--grid) 45%,transparent);box-shadow:inset 0 5px 0 color-mix(in srgb,var(--acc) 54%,transparent),0 5px 16px color-mix(in srgb,var(--ink) 8%,transparent)}
html[data-style="mochi"] .card:hover{transform:translateY(-2px) scale(1.006);box-shadow:inset 0 5px 0 var(--acc),0 10px 24px color-mix(in srgb,var(--ink) 12%,transparent)}
html[data-style="mochi"] button{font-weight:600}
html[data-style="mochi"] .row.sel{outline:none;box-shadow:inset 4px 0 0 var(--acc)}
html[data-style="mochi"] .statechip{border:2px solid color-mix(in srgb,var(--surface) 78%,transparent);padding-block:0}

/* Block Party: poster ink, offset registration, and hard physical edges. */
html[data-style="blockparty"] body{background-image:radial-gradient(color-mix(in srgb,var(--grid) 18%,transparent) .9px,transparent .9px);background-size:16px 16px;background-attachment:fixed}
html[data-style="blockparty"] header.top{border-top:8px solid var(--acc);border-bottom:2px solid var(--grid)}
html[data-style="blockparty"] aside{background:var(--surface);border-right:2px solid var(--grid)}
html[data-style="blockparty"] .phead{background:var(--surface);border-bottom:2px solid var(--grid)}
html[data-style="blockparty"] header.top h1,html[data-style="blockparty"] .phead h2,html[data-style="blockparty"] aside h2,html[data-style="blockparty"] .col h3{text-transform:uppercase;letter-spacing:.025em}
html[data-style="blockparty"] .phead h2{background:var(--acc);color:var(--acc-ink);border:2px solid var(--grid);padding:3px 7px;box-shadow:3px 3px 0 var(--grid)}
html[data-style="blockparty"] .col{box-shadow:var(--shadow)}
html[data-style="blockparty"] .card{margin-right:5px;box-shadow:3px 3px 0 var(--grid)}
html[data-style="blockparty"] .card:hover{transform:translate(-2px,-2px);box-shadow:5px 5px 0 var(--grid)}
html[data-style="blockparty"] button.primary{border-color:var(--grid);box-shadow:3px 3px 0 var(--grid)}
html[data-style="blockparty"] button.primary:hover{transform:translate(-1px,-1px);box-shadow:4px 4px 0 var(--grid)}
html[data-style="blockparty"] .statechip{border:1px solid var(--grid);font-weight:800;text-transform:uppercase}
html[data-style="blockparty"] .meter .track,html[data-style="blockparty"] .strip{border-radius:0;border:1px solid var(--grid)}

.settings{max-width:1180px}
.setting-title{font:700 12px/1.2 var(--display);text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
.setting-note{color:var(--muted);font-size:12px;margin-top:3px}
.settings .stiles{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:14px;margin:12px 0 24px}
.stile{display:block;width:100%;min-width:0;border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);padding:10px;cursor:pointer;background:var(--surface);text-align:left;box-shadow:none;transition:transform .14s ease,border-color .14s ease}
.stile:hover{border-color:var(--acc);transform:translateY(-2px)}
.stile.on{outline:2px solid var(--acc);outline-offset:2px}
.stile .prev{--pv-page:#eee;--pv-surface:#fff;--pv-surface2:#ddd;--pv-grid:#bbb;--pv-ink:#222;--pv-acc:#2680e8;height:82px;border:1px solid var(--pv-grid);border-radius:8px;margin-bottom:9px;overflow:hidden;background:var(--pv-page);color:var(--pv-ink);position:relative}
.prev .pvbar{height:18px;border-bottom:1px solid var(--pv-grid);background:var(--pv-surface);display:flex;align-items:center;gap:4px;padding:0 6px}
.prev .pvbar i{width:6px;height:6px;border-radius:50%;background:var(--pv-acc)}
.prev .pvbar span{width:28px;height:4px;background:var(--pv-ink);opacity:.75}
.prev .pvbar b{width:13px;height:4px;background:var(--pv-grid);margin-left:auto}
.prev .pvbody{height:63px;display:grid;grid-template-columns:28px 1fr}
.prev .pvside{background:var(--pv-surface2);border-right:1px solid var(--pv-grid);padding:7px 5px;display:flex;flex-direction:column;gap:5px}
.prev .pvside i{display:block;height:3px;background:var(--pv-ink);opacity:.35}
.prev .pvside i:nth-child(2){background:var(--pv-acc);opacity:1}
.prev .pvdeck{padding:7px;display:flex;gap:6px;align-items:flex-start}
.prev .pvcard{height:43px;flex:1;min-width:0;background:var(--pv-surface);border:1px solid var(--pv-grid);border-radius:5px;position:relative;box-shadow:0 2px 5px color-mix(in srgb,var(--pv-ink) 10%,transparent)}
.prev .pvcard::before,.prev .pvcard::after{content:"";position:absolute;left:5px;right:5px;height:3px;background:var(--pv-ink);opacity:.48}
.prev .pvcard::before{top:9px}.prev .pvcard::after{top:17px;right:10px;opacity:.2}
.prev.pv-harbor{background-image:radial-gradient(circle at 8% 0,color-mix(in srgb,var(--pv-acc) 24%,transparent),transparent 42%)}
.prev.pv-harbor .pvcard{border-color:transparent;border-radius:8px;box-shadow:inset 0 3px 0 color-mix(in srgb,var(--pv-acc) 48%,transparent),0 4px 8px color-mix(in srgb,var(--pv-ink) 12%,transparent)}
.prev.pv-phosphor{border-radius:0;background-image:linear-gradient(color-mix(in srgb,var(--pv-acc) 12%,transparent) 1px,transparent 1px),linear-gradient(90deg,color-mix(in srgb,var(--pv-acc) 12%,transparent) 1px,transparent 1px);background-size:12px 12px}
.prev.pv-phosphor .pvcard{border-radius:0;border-left:2px solid var(--pv-acc);box-shadow:none}
.prev.pv-phosphor .pvbar i,.prev.pv-phosphor .pvside i{border-radius:0}
.prev.pv-fieldnotes{border-radius:2px;background-image:repeating-linear-gradient(to bottom,transparent 0,transparent 11px,color-mix(in srgb,var(--pv-grid) 55%,transparent) 12px)}
.prev.pv-fieldnotes .pvcard{border-radius:1px;border-left:3px double var(--pv-acc);box-shadow:1px 2px 0 color-mix(in srgb,var(--pv-ink) 22%,transparent)}
.prev.pv-fieldnotes .pvcard:nth-child(2){transform:rotate(.8deg)}
.prev.pv-mochi{border-radius:12px;background-image:radial-gradient(circle at 88% 10%,color-mix(in srgb,var(--pv-acc) 24%,transparent),transparent 42%)}
.prev.pv-mochi .pvcard{border-color:transparent;border-radius:11px;box-shadow:inset 0 4px 0 color-mix(in srgb,var(--pv-acc) 55%,transparent),0 5px 9px color-mix(in srgb,var(--pv-ink) 12%,transparent)}
.prev.pv-blockparty{border:2px solid var(--pv-grid);border-radius:0;background-image:radial-gradient(color-mix(in srgb,var(--pv-grid) 25%,transparent) .7px,transparent .7px);background-size:8px 8px}
.prev.pv-blockparty .pvbar{border-bottom-width:2px;border-top:5px solid var(--pv-acc);height:20px}
.prev.pv-blockparty .pvbody{height:60px}
.prev.pv-blockparty .pvcard{border:2px solid var(--pv-grid);border-radius:0;box-shadow:3px 3px 0 var(--pv-grid)}
.stile b{font:700 13px/1.2 var(--display)}
.stile .blurb{font-size:11px;color:var(--muted);margin-top:3px}
.accents{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 16px}
.accpill{display:inline-flex;align-items:center;gap:6px;border:var(--bw) var(--bs) var(--grid);border-radius:999px;padding:4px 11px;cursor:pointer;font-size:12px;background:var(--surface);box-shadow:none}
.accpill.on{outline:2px solid var(--acc);outline-offset:1px;background:var(--surface2)}
.accpill .sw{width:12px;height:12px;border-radius:50%}
.setting-pair{display:grid;grid-template-columns:repeat(3,minmax(180px,1fr));gap:24px;max-width:960px;margin:5px 0 20px}
.setting-group{min-width:0}
.limitctl{display:flex;align-items:center;gap:9px;margin-top:9px;font-size:12px;color:var(--ink2)}
.limitctl input{width:70px}
.segsel{display:flex;gap:7px;margin-top:9px;flex-wrap:wrap}
.segsel button{min-width:88px;text-align:left}
.segsel button span{display:block;font-weight:650;text-transform:capitalize}
.segsel button small{display:block;font-size:10px;color:var(--muted);font-weight:400;margin-top:1px}
.segsel button.primary small{color:color-mix(in srgb,var(--acc-ink) 74%,transparent)}
.accpill input[type=color]{width:18px;height:18px;padding:0;border:none;background:none;cursor:pointer}
button.danger{background:var(--st-blocked);color:#fff;border-color:transparent}
.mrow{display:flex;align-items:center;gap:9px;padding:5px 8px;border-radius:var(--rk);font-size:13px}
.mrow:hover{background:var(--surface)}
.mrow .who{color:var(--muted);font-size:11px}
.mrow button{margin-left:auto;font-size:11px;padding:1px 8px}
.mkids{margin-left:16px;border-left:1px dashed var(--grid);padding-left:8px}
@media (hover:none){.lanefoot{opacity:1;transform:none;pointer-events:auto;border-top-color:var(--grid)}}
@media (max-width: 760px){
  #burger{display:inline-flex}
  header.top{gap:10px;padding:10px 12px;flex-wrap:wrap}
  header.top .strip,header.top #hstrip{display:none}
  .meter .track{width:80px}
  aside{position:fixed;left:0;top:0;bottom:0;z-index:18;transform:translateX(-105%);transition:transform .16s ease;background:var(--page);box-shadow:8px 0 30px rgba(0,0,0,.25);width:min(300px,86vw)}
  aside.open{transform:none}
  .phead{padding:10px 12px;gap:8px}
  .searchbox{order:4;width:100%;flex-wrap:wrap}.searchbox input{width:auto;flex:1;min-width:160px}.searchbox select{max-width:42vw}
  .tabs{margin-left:0;width:100%}
  .view{padding:10px 12px}
  .cols{scroll-snap-type:x mandatory;overflow-x:auto;margin:0 -12px;padding:0 12px}
  .col{width:84vw;min-width:84vw;scroll-snap-align:start}
  .overlay{padding:0;align-items:stretch}
  .modal{max-width:100%}
  .cardmodal{max-width:100%;border-radius:0;min-height:100vh}
  .settings .stiles{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}
  .setting-pair{grid-template-columns:1fr;gap:18px}
}
@media (min-width:761px) and (max-width:1300px){.settings .stiles{grid-template-columns:repeat(auto-fit,minmax(185px,1fr))}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important}}
`;

const JS = `
const ORDER=['wishlist','todo','blocked','doing','done','archive'];
const THEMES=window.__THEMES__;
const $=(s,el)=>(el||document).querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const linkOk=u=>{try{return['https:','http:','mailto:'].includes(new URL(u,location.href).protocol)}catch{return false}};
const imageOk=u=>{try{const x=new URL(u,location.href);return x.protocol==='data:'?/^data:image\//i.test(u):x.protocol==='blob:'||((x.protocol==='http:'||x.protocol==='https:')&&x.origin===location.origin)}catch{return false}};
const pct=p=>p==null?'·':Math.round(p*100)+'%';
const IC={check:'<svg class="ic" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="3"/><path d="M5 8.2l2.2 2.2L11.5 6"/></svg>',
  chat:'<svg class="ic" viewBox="0 0 16 16"><path d="M2.5 3.5h11v7h-6l-3 3v-3h-2z"/></svg>',
  clip:'<svg class="ic" viewBox="0 0 16 16"><path d="M12.5 7.5l-4.6 4.6a3 3 0 0 1-4.2-4.2L9 2.6a2 2 0 0 1 2.9 2.9L7 10.4a1 1 0 0 1-1.5-1.5l4.2-4.2"/></svg>',
  gear:'<svg class="ic" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.4"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4"/></svg>',
  tick:'<svg class="ic" style="stroke-width:2.6" viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-6.5"/></svg>',
  open:'<svg class="ic" viewBox="0 0 16 16"><path d="M6.5 3.5h-3v9h9v-3M9.5 2.5h4v4M13 3L7.5 8.5"/></svg>'};
let TOKEN=localStorage.getItem('bf_token')||'';
const PUB=window.__PUB__||null;
const PUBCARD=window.__PUBCARD__||null;
let RO=!!PUB;
const cardApi=cid=>PUB?'/api/public/'+PUB+'/cards/'+cid:'/api/projects/'+SEL+'/cards/'+cid;
const cardReadApi=cid=>cardApi(cid)+'?compact=1';
const cardHistoryApi=(cid,kind)=>cardApi(cid)+'/'+kind;
let THEME={style:'harbor',accent:'pacific',mode:'system',density:'relaxed',custom:null,cardTagLimit:${DEFAULT_CARD_TAG_LIMIT}};
let ORG=null,SEL=null,VIEW='board',BOARD=null,timer=null,MODAL=null,UPLOADS=false;
let LAYOUT=localStorage.getItem('bf_layout')||'kanban';
if(!['kanban','table','swimlane','calendar','timeline','grouped','metrics','hill'].includes(LAYOUT))LAYOUT='kanban';
let GROUP_AXIS=localStorage.getItem('bf_group_axis')||'assignee';
let SWIM_AXIS=localStorage.getItem('bf_swim_axis')||'assignee';
let CAL_MONTH=null,TABLE_SORT='id',TABLE_DESC=false,HILL_DRAG=null;
const HILL_PENDING=new Map();
// Role gates, refreshed from /api/org on every boot. RO stays the read-only
// flag for public share pages; these are about who is logged in.
let ME=null,CAN_WRITE=false,CAN_SHAPE=false,IS_OWNER=false,DIR=new Map();
// Search state lives outside the board DOM. Polling only morphs #view, so a
// focused query input is never replaced while someone is typing.
let SEARCH_PROJECT=null,SEARCH_QUERY='',SEARCH_SAVED='',SEARCH_IDS=null,SEARCH_TIMER=null,SEARCH_SEQ=0;
let NEW_FEED=null;
let INTEGRATION_NOTICE=null;
// Usernames are what boards store; display names are what people read. One
// lookup here is what makes renaming a member update every card at once.
function who(u){if(!u)return '';const m=DIR.get(u);return m?m.display:u}
const mq=matchMedia('(prefers-color-scheme: dark)');
mq.addEventListener('change',()=>applyTheme(THEME));
function contrastInk(hex){
  const channel=n=>{const c=n/255;return c<=.04045?c/12.92:Math.pow((c+.055)/1.055,2.4)};
  const n=parseInt(hex.slice(1),16),l=.2126*channel(n>>16&255)+.7152*channel(n>>8&255)+.0722*channel(n&255);
  return 1.05/(l+.05)>=(l+.05)/.05?'#ffffff':'#141414';
}
function applyTheme(t){
  const st=THEMES.find(s=>s.id===t.style)||THEMES[0];
  const density=t.density==='compact'?'compact':'relaxed';
  const cardTagLimit=Number.isInteger(t.cardTagLimit)&&t.cardTagLimit>=0&&t.cardTagLimit<=${MAX_CARD_TAG_LIMIT}?t.cardTagLimit:${DEFAULT_CARD_TAG_LIMIT};
  const modeChoice=t.mode==='light'||t.mode==='dark'?t.mode:'system';
  const mode=modeChoice==='system'?(mq.matches?'dark':'light'):modeChoice;
  const p=st[mode],d=st.densities[density];
  let a,accent;
  if(t.accent==='custom'&&t.custom){accent='custom';a={acc:t.custom,accInk:contrastInk(t.custom)}}
  else{const found=st.accents.find(x=>x.id===t.accent)||st.accents[0];accent=found.id;a=found[mode]}
  THEME={style:st.id,accent,mode:modeChoice,density,custom:t.custom||null,cardTagLimit};
  const R=document.documentElement.style;
  const set=(k,v)=>R.setProperty(k,v);
  set('--page',p.page);set('--surface',p.surface);set('--surface2',p.surface2);set('--ink',p.ink);set('--ink2',p.ink2);
  set('--muted',p.muted);set('--grid',p.grid);set('--baseline',p.baseline);set('--ring',p.ring);
  set('--st-wishlist',p.stWishlist);set('--st-todo',p.stTodo);set('--st-blocked',p.stBlocked);
  set('--st-doing',p.stDoing);set('--st-done',p.stDone);set('--st-archive',p.stArchive);
  set('--acc',a.acc);set('--acc-ink',a.accInk);
  set('--rc',st.radiusCard);set('--rk',st.radiusCtl);set('--bw',st.borderW);set('--bs',st.borderStyle||'solid');
  set('--shadow',mode==='dark'?st.shadowDark:st.shadowLight);set('--font',st.font);set('--display',st.displayFont);
  set('--base-size',d.baseSize);set('--line-height',d.lineHeight);set('--header-pad',d.headerPad);
  set('--side-w',d.sideWidth);set('--side-pad',d.sidePad);set('--pane-head-pad',d.paneHeadPad);set('--view-pad',d.viewPad);
  set('--col-w',d.columnWidth);set('--col-gap',d.columnGap);set('--col-pad',d.columnPad);set('--card-gap',d.cardGap);
  set('--card-pad',d.cardPad);set('--control-pad',d.controlPad);set('--field-pad',d.fieldPad);set('--art-h',d.artHeight);
  document.documentElement.dataset.style=st.id;
  document.documentElement.dataset.density=density;
  document.documentElement.style.colorScheme=mode;
  const meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.setAttribute('content',p.page);
}
async function api(path,opts){
  const res=await fetch(path,{...opts,headers:{'content-type':'application/json',...(TOKEN?{authorization:'Bearer '+TOKEN}:{}),...(opts&&opts.headers||{})}});
  const body=await res.json().catch(()=>({}));
  // Keep the parsed body on the error: a claim conflict carries structure
  // (reason, holder, position) that the message alone cannot express.
  if(!res.ok){const e=new Error(body.error||res.status);e.status=res.status;e.body=body;throw e}
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
// Dialogs are real dialogs: role + aria-modal, focus moves in on open and is
// trapped (Tab cycles, Escape closes), and it returns to the opener on close.
function closeOverlay(){
  const o=$('.overlay');
  if(o){const back=o._restoreFocus;o.remove();if(back&&back.focus&&document.contains(back))back.focus()}
  MODAL=null;
}
function trapDialogTab(e,root){
  if(e.key!=='Tab')return;
  const f=[...root.querySelectorAll('button,[href],input,textarea,select,[tabindex]:not([tabindex="-1"])')]
    .filter(x=>!x.disabled&&x.offsetParent!==null);
  if(!f.length)return;
  const first=f[0],last=f[f.length-1];
  if(e.shiftKey&&document.activeElement===first){last.focus();e.preventDefault()}
  else if(!e.shiftKey&&(document.activeElement===last||!root.contains(document.activeElement))){first.focus();e.preventDefault()}
}
function overlay(html,cls,label){
  closeOverlay();
  const opener=document.activeElement;
  const o=document.createElement('div');o.className='overlay';
  o.innerHTML='<div class="modal '+(cls||'')+'" role="dialog" aria-modal="true" tabindex="-1"'+(label?' aria-label="'+esc(label)+'"':'')+'>'+html+'</div>';
  o.addEventListener('mousedown',e=>{if(e.target===o)closeOverlay()});
  o.addEventListener('keydown',e=>trapDialogTab(e,o));
  o._restoreFocus=opener&&opener!==document.body?opener:null;
  document.body.appendChild(o);
  const m=o.firstElementChild;
  m.focus();
  return m;
}
function formModal(title,fields,submitLabel,onSubmit){
  const m=overlay('<h3>'+esc(title)+'</h3><form>'+fields.map(f=>
    '<div class="field"><label>'+esc(f.label)
    +(f.type==='textarea'
      ?'<textarea name="'+f.name+'" rows="'+(f.rows||6)+'" placeholder="'+esc(f.placeholder||'')+'" '+(f.required?'required':'')+'>'+esc(f.value??'')+'</textarea>'
      :f.type==='select'
        ?'<select name="'+f.name+'">'+(f.options||[]).map(o=>'<option value="'+esc(o.value)+'"'+(String(f.value??'')===String(o.value)?' selected':'')+'>'+esc(o.label)+'</option>').join('')+'</select>'
        :'<input name="'+f.name+'" type="'+(f.type==='password'?'password':f.type==='number'?'number':f.type==='url'?'url':'text')+'"'+(f.type==='password'?' autocomplete="new-password"':'')+' value="'+esc(f.value??'')+'" placeholder="'+esc(f.placeholder||'')+'" '+(f.required?'required':'')+'>')
    +'</label></div>').join('')
    +'<div class="err" role="alert"></div><div class="actions"><button type="button" class="ghost" data-x>cancel</button><button class="primary">'+esc(submitLabel)+'</button></div></form>',null,title);
  $('form',m).onsubmit=async e=>{e.preventDefault();
    const data={};for(const f of fields)data[f.name]=$('[name="'+f.name+'"]',m).value.trim();
    try{await onSubmit(data);closeOverlay()}catch(err){$('.err',m).textContent=err.message}};
  $('[data-x]',m).onclick=closeOverlay;
  const first=$('input,textarea,select',m);if(first)first.focus();
}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeOverlay()});
function confirmModal(title,message,confirmLabel,onConfirm){
  const m=overlay('<h3>'+esc(title)+'</h3><p style="font-size:13px;color:var(--ink2);line-height:1.55">'+message+'</p>'
    +'<div class="err" role="alert"></div><div class="actions"><button type="button" class="ghost" data-x>cancel</button><button class="danger" data-go>'+esc(confirmLabel)+'</button></div>',null,title);
  $('[data-x]',m).onclick=closeOverlay;
  $('[data-go]',m).onclick=async()=>{
    const b=$('[data-go]',m);b.disabled=true;b.textContent='working…';
    try{await onConfirm();closeOverlay()}catch(err){$('.err',m).textContent=err.message;b.disabled=false;b.textContent=confirmLabel}
  };
}
function wireTablist(host,attribute,activate){
  if(!host)return;
  const selector='['+attribute+']';
  const tabs=()=>[...host.querySelectorAll(selector)];
  const sync=()=>{for(const tab of tabs())tab.tabIndex=tab.getAttribute('aria-selected')==='true'?0:-1};
  sync();
  host.onclick=e=>{const tab=e.target.closest(selector);if(tab&&host.contains(tab))activate(tab)};
  host.onkeydown=e=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
    const all=tabs(),at=all.indexOf(e.target.closest(selector));if(at<0||!all.length)return;
    e.preventDefault();
    const next=e.key==='Home'?all[0]:e.key==='End'?all[all.length-1]:all[(at+(e.key==='ArrowRight'?1:-1)+all.length)%all.length];
    next.focus();
  };
}
// ---- boot ----
function gate(kind,extra){
  document.body.innerHTML='<div class="gate" id="gate"></div>';
  const g=$('#gate');
  // Setup, recovery and login all end the same way: a live session, stored
  // where api() already looks for it. No token to copy down any more.
  const enter=r=>{TOKEN=r.token;localStorage.setItem('bf_token',TOKEN);start()};
  if(kind==='setup'){
    // Ask for as little as the deployment actually needs. The setup key only
    // exists to stop a stranger claiming a public deployment first, so a
    // loopback instance that ignores it should not be asking for one; and the
    // company name has a default and can be renamed later, so it is optional.
    const cfg=(extra&&extra.setup)||{needsKey:false,locked:false};
    if(cfg.locked){
      g.innerHTML='<h2>Setup is locked</h2><p>This deployment is reachable from the internet, so it will not initialize until a <code>SETUP_KEY</code> Worker secret is configured. Without it, whoever loads this page first would own the company.</p>'
        +'<p style="font-size:12px;color:var(--muted)">Set one with <code>npx wrangler secret put SETUP_KEY</code>, or under Settings &rarr; Variables and Secrets in the Cloudflare dashboard, then reload.</p>';
    }else{
      g.innerHTML='<h2>Set up botflow manager</h2><p>Create the account that owns this deployment.</p>'
        +'<form id="f" style="flex-direction:column">'
        +'<input id="user" placeholder="owner username (a-z, 0-9, - and _)" autocomplete="username" required style="margin-bottom:8px">'
        +'<input id="pw" type="password" placeholder="password (8+ characters)" autocomplete="new-password" required style="margin-bottom:8px">'
        +'<input id="name" placeholder="company name (optional, you can change it later)" style="margin-bottom:8px">'
        +(cfg.needsKey?'<input id="skey" placeholder="setup key" autocomplete="off" required style="margin-bottom:8px">':'')
        +'<button class="primary">Initialize</button></form><div class="err" id="err"></div>';
      $('#f').onsubmit=async e=>{e.preventDefault();
        const k=$('#skey');
        try{enter(await api('/api/setup',{method:'POST',body:JSON.stringify({
          name:$('#name').value.trim()||undefined,username:$('#user').value.trim(),password:$('#pw').value,
          setupKey:k&&k.value?k.value:undefined})}));
        }catch(err){$('#err').textContent=err.message}};
    }
  }else if(kind==='recover'){
    g.innerHTML='<h2>Recover owner access</h2><p>The <code>SETUP_KEY</code> Worker secret resets an owner password, or installs an owner if every one is gone. Every live session ends and the audit log records it. Loopback development needs no key.</p>'
      +'<form id="f" style="flex-direction:column"><input id="ruser" placeholder="owner username" autocomplete="username" required style="margin-bottom:8px">'
      +'<input id="rpw" type="password" placeholder="new password (8+ characters)" autocomplete="new-password" required style="margin-bottom:8px">'
      +'<input id="rkey" placeholder="setup key" autocomplete="off" style="margin-bottom:8px">'
      +'<button class="primary">recover →</button></form>'
      +'<div class="err" id="err"></div>'
      +'<div style="margin-top:10px"><a href="#" id="backlogin" style="font-size:11.5px;color:var(--muted)">back to login</a></div>';
    $('#f').onsubmit=async e=>{e.preventDefault();
      try{enter(await api('/api/recover',{method:'POST',body:JSON.stringify({
        username:$('#ruser').value.trim(),password:$('#rpw').value,setupKey:$('#rkey').value||undefined})}));
      }catch(err){$('#err').textContent=err.message}};
    $('#backlogin').onclick=e=>{e.preventDefault();gate('token')};
  }else{
    g.innerHTML='<h2>botflow manager</h2>'+(typeof extra==='string'&&extra?'<p class="err">'+esc(extra)+'</p>':'')
      +'<form id="f" style="flex-direction:column"><input id="user" placeholder="username" autocomplete="username" required style="margin-bottom:8px">'
      +'<input id="pw" type="password" placeholder="password" autocomplete="current-password" required style="margin-bottom:8px">'
      +'<button class="primary">log in →</button></form><div class="err" id="err"></div>'
      +'<div id="gateshares"></div>'
      +'<div style="margin-top:10px"><a href="#" id="lost" style="font-size:11.5px;color:var(--muted)">lost access?</a></div>';
    $('#f').onsubmit=async e=>{e.preventDefault();
      try{enter(await api('/api/login',{method:'POST',body:JSON.stringify({username:$('#user').value.trim(),password:$('#pw').value})}));
      }catch(err){$('#err').textContent=err.message}};
    $('#lost').onclick=e=>{e.preventDefault();gate('recover')};
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
  if(org.uninitialized){
    let cfg=null;
    try{cfg=(await api('/api/public/gate')).setup}catch{}
    return gate('setup',{setup:cfg});
  }
  adoptOrg(org);
  if(SEL&&!findAny(SEL))SEL=null;
  if(!SEL){const first=firstProject(ORG);SEL=first?first.id:null}
  layout();
}
function firstProject(org){for(const s of org.spaces)if(s.projects.length)return s.projects[0];return null}
function findProject(id,nodes){for(const n of nodes||[]){if(n.id===id)return n;const d=findProject(id,n.children);if(d)return d}return null}
function findAny(id){for(const s of ORG.spaces){const p=findProject(id,s.projects);if(p)return p}return null}
function spaceOf(pid){for(const s of ORG.spaces)if(findProject(pid,s.projects))return s.id;return null}
// Everything derived from /api/org, in one place: the tree, who I am, what I
// may do, and the username -> display name table. reloadOrg has to refresh all
// of it, or a rename (or a role change) sits stale until the page is reloaded.
function adoptOrg(org){
  ORG=org;UPLOADS=org.uploads===true;
  ME=org.me||null;
  CAN_WRITE=!!ME&&['write','admin','owner'].includes(ME.role);
  CAN_SHAPE=!!ME&&['admin','owner'].includes(ME.role);
  IS_OWNER=!!ME&&ME.role==='owner';
  RO=!!PUB||!CAN_WRITE;
  DIR=new Map((org.directory||[]).map(m=>[m.username,m]));
}
// Awaits the board too: callers that await this expect the deck to be current
// when it resolves, or anything touching the re-rendered DOM afterwards (like
// putting keyboard focus back on a card that just moved) acts on the old one.
async function reloadOrg(){
  let org;try{org=await api('/api/org')}catch(err){if(err.status===401){TOKEN='';localStorage.removeItem('bf_token');gate('token','session expired');return}throw err}
  adoptOrg(org);renderSide();renderHeader();if(VIEW==='board'&&BOARD){BOARD=null;await refreshBoard()}
}
function renderHeader(){
  const agg=ORG.aggregate;
  const name=$('#horg');if(name)name.textContent=ORG.name;
  $('#hmeter').innerHTML='<div class="track"><div class="fill" style="width:'+Math.round((agg.progress||0)*100)+'%"></div></div><b>'+pct(agg.progress)+'</b>';
  $('#hstrip').outerHTML='<span id="hstrip">'+strip(agg.distribution)+'</span>';
}
function layout(){
  document.body.innerHTML=
    '<header class="top"><button id="burger" class="ghost" aria-label="menu">☰</button><h1><span id="horg">'+esc(ORG.name)+'</span> <span class="sub">botflow manager</span></h1>'
    +'<div class="meter" id="hmeter" title="structural progress: every card is one unit; a sub-board fills its unit by its own fraction"></div><span id="hstrip"></span>'
    +'<span class="spacer"></span>'+(ME?'<span class="whoami" title="'+esc(ME.username+' · '+ME.role+' on '+ME.scope.kind)+'">'+esc(ME.display)+' <i>'+esc(ME.role)+'</i></span>':'')
    +'<button id="setbtn" class="ghost" title="settings">'+IC.gear+' settings</button><button id="logout" class="ghost">log out</button></header>'
    +'<div class="app"><aside id="side"></aside><section class="content" id="main"></section></div>';
  $('#logout').onclick=async()=>{
    try{await api('/api/logout',{method:'POST'})}catch{}
    localStorage.removeItem('bf_token');TOKEN='';gate('token')};
  $('#setbtn').onclick=()=>{VIEW='settings';renderSide();renderMain()};
  $('#burger').onclick=()=>$('#side').classList.toggle('open');
  renderHeader();renderSide();renderMain();
  timer=setInterval(()=>{if(VIEW==='board'&&SEL&&!MODAL&&!DRAG&&!PRESS&&!HILL_DRAG)refreshBoard(true)},3000);
}
function projRow(n){
  const a=n.aggregate;
  return '<div class="row '+(VIEW!=='settings'&&n.id===SEL?'sel':'')+'" data-proj="'+n.id+'" tabindex="0" role="button" aria-label="'+esc(n.name)+'">'
    +esc(n.name)+(CAN_WRITE?'<button class="add" data-addsub="'+n.id+'" title="add sub-project">+</button>':'')
    +'<span class="pct">'+pct(a.progress)+'</span>'+statechip(a.state)+'</div>'
    +(n.children.length?'<div class="kids">'+n.children.map(projRow).join('')+'</div>':'');
}
function renderSide(){
  $('#side').innerHTML=ORG.spaces.map(s=>
    '<div class="space"><h2>'+esc(s.name)+' <span class="pct" style="margin-left:6px">'+pct(s.aggregate.progress)+'</span>'
    +(IS_OWNER?'<button data-addproj="'+s.id+'">+ project</button>':'')+'</h2>'
    +(s.projects.length?s.projects.map(projRow).join(''):'<div class="empty">no projects</div>')
    +'</div>').join('')
    +(IS_OWNER?'<h2>company <button id="addspace">+ space</button></h2>':'')
    +'<div class="sidefoot"><div class="row '+(VIEW==='settings'?'sel':'')+'" id="setrow" tabindex="0" role="button">'+IC.gear+' settings</div></div>';
  $('#side').onclick=async e=>{
    if(e.target.closest('#setrow')){VIEW='settings';renderSide();renderMain();return}
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
  $('#side').onkeydown=e=>{
    if(e.key!=='Enter'&&e.key!==' ')return;
    const row=e.target.closest('[data-proj],#setrow');
    if(row){e.preventDefault();row.click()}
  };
  const sp=$('#addspace');if(sp)sp.onclick=()=>formModal('New space',[{name:'name',label:'space name',required:true}],'create',async d=>{
    await api('/api/spaces',{method:'POST',body:JSON.stringify({name:d.name})});await reloadOrg()});
}
function renderMain(){
  const main=$('#main');
  if(VIEW==='settings')return renderSettings(main);
  const p=SEL?findAny(SEL):null;
  if(!p){main.innerHTML='<div class="view"><div class="empty">'
    +(IS_OWNER?'Create a space and a project to begin. Bots connect with their own credentials via the REST API or <code>botflow push</code>.'
      :'Nothing here yet. An owner has to give you a space or a project before there is a board to work.')
    +'</div></div>';return}
  if(SEARCH_PROJECT!==SEL){
    if(SEARCH_TIMER)clearTimeout(SEARCH_TIMER);
    SEARCH_PROJECT=SEL;SEARCH_QUERY='';SEARCH_SAVED='';SEARCH_IDS=null;SEARCH_SEQ++;NEW_FEED=null;INTEGRATION_NOTICE=null;
  }
  // Feeds are personal member capabilities, while public sharing remains a
  // company-level decision. Every member can therefore reach feeds; only an
  // owner gets the public-sharing tab.
  const tabs=['board','activity','feeds'].concat(IS_OWNER?['sharing','integrations']:[]);
  if(!tabs.includes(VIEW))VIEW='board';
  const filters=(BOARD&&BOARD.filters)||[];
  const search=VIEW==='board'?'<div class="searchbox" role="search">'
    +'<input id="cardsearch" value="'+esc(SEARCH_QUERY)+'" placeholder="search cards or use field:value" aria-label="search cards">'
    +'<select id="savedsearch" aria-label="saved card filter"><option value="">saved filters</option>'
    +filters.map(f=>'<option value="'+esc(f.id)+'"'+(SEARCH_SAVED===f.id?' selected':'')+'>'+esc(f.name)+'</option>').join('')+'</select>'
    +(CAN_WRITE?'<button type="button" class="ghost" id="savefilter" title="save this query">save</button>':'')
    +(CAN_WRITE?'<button type="button" class="ghost" id="delfilter" title="delete selected saved filter"'+(SEARCH_SAVED?'':' disabled')+'>✕</button>':'')
    +'<button type="button" class="ghost" id="clearsearch" title="clear search"'+(SEARCH_QUERY||SEARCH_SAVED?'':' disabled')+'>clear</button>'
    +'<span class="searchstatus" id="searchstatus" aria-live="polite"></span></div>':'';
  main.innerHTML='<div class="phead"><h2>'+esc(p.name)+'</h2><span class="pct" id="pinfo"></span>'
    +search
    +(CAN_WRITE?'<span id="boardbuttons"></span><button id="automate" class="ghost" title="run reminders, wake snoozed cards, and sweep completed work">↻ automate</button>':'')
    +(CAN_WRITE?'<button id="newcard" class="ghost" title="add a card to this board">+ card</button>':'')
    +(CAN_WRITE?'<button id="quickcard" class="ghost" title="create several cards with quick-add syntax">+ quick</button><button id="bulkcard" class="ghost" title="move, close, or label several card ids">bulk</button>':'')
    +(CAN_SHAPE?'<button id="editboard" class="ghost" title="edit lanes, substates, wip, rollup">✎ edit board</button>':'')
    +(VIEW==='board'?'<div class="viewctl"><select id="boardlayout" aria-label="board view">'
      +[['kanban','board'],['table','table'],['swimlane','swimlanes'],['calendar','calendar'],['timeline','timeline'],['grouped','group by field'],['metrics','metrics'],['hill','hill chart']].map(x=>'<option value="'+x[0]+'"'+(LAYOUT===x[0]?' selected':'')+'>'+x[1]+'</option>').join('')+'</select>'
      +'<select id="axisctl" class="axisctl" aria-label="grouping axis" hidden></select></div>':'')
    +'<div class="tabs" role="tablist">'+tabs.map(t=>
      '<button data-tab="'+t+'" role="tab" aria-selected="'+(VIEW===t)+'" class="'+(VIEW===t?'on':'')+'">'+t+'</button>').join('')+'</div></div>'
    +'<div class="view" id="view">loading…</div>';
  wireTablist(main.querySelector('.tabs'),'data-tab',b=>{VIEW=b.dataset.tab;renderMain()});
  const eb=$('#editboard');if(eb)eb.onclick=boardEditor;
  const nc=$('#newcard');if(nc)nc.onclick=()=>newCard();
  const qc=$('#quickcard');if(qc)qc.onclick=quickCards;
  const bc=$('#bulkcard');if(bc)bc.onclick=bulkCardsUi;
  const automate=$('#automate');if(automate)automate.onclick=async()=>{
    automate.disabled=true;
    try{const r=await api('/api/projects/'+SEL+'/automate',{method:'POST',body:'{}'});await reloadOrg();toast('Automation applied '+((r.actions||[]).length)+' action(s).')}
    catch(err){toast(err.message)}finally{if(document.contains(automate))automate.disabled=false}
  };
  const layoutCtl=$('#boardlayout');if(layoutCtl)layoutCtl.onchange=()=>{
    LAYOUT=layoutCtl.value;localStorage.setItem('bf_layout',LAYOUT);syncViewControls(BOARD);
    if(LAYOUT==='metrics'&&BOARD&&!BOARD.flow)refreshBoard();else paintBoard();
  };
  const axisCtl=$('#axisctl');if(axisCtl)axisCtl.onchange=()=>{
    if(LAYOUT==='grouped'){GROUP_AXIS=axisCtl.value;localStorage.setItem('bf_group_axis',GROUP_AXIS)}
    else if(LAYOUT==='swimlane'){SWIM_AXIS=axisCtl.value;localStorage.setItem('bf_swim_axis',SWIM_AXIS)}
    paintBoard();
  };
  if(VIEW==='board'){wireSearchControls();refreshBoard()}
  else if(VIEW==='activity')refreshActivity();
  else if(VIEW==='feeds')refreshFeeds();
  else if(VIEW==='sharing')refreshSharing();
  else refreshIntegrations();
}

function renderBoardButtons(){
  const host=$('#boardbuttons');if(!host)return;
  const buttons=((BOARD&&BOARD.buttons)||[]).filter(b=>b.scope==='board');
  const sig=buttons.map(b=>[b.id,b.name,b.action,b.value||''].join('\u0000')).join('\u0001');
  if(host.dataset.sig!==sig){
    patchView(host,buttons.map(b=>'<button class="ghost" data-morph-key="board-button:'+esc(b.id)+'" data-boardbutton="'+esc(b.id)+'" title="'+esc(b.action+(b.value?' '+b.value:''))+'">'+esc(b.name)+'</button>').join(''));
    host.dataset.sig=sig;
  }
  host.onclick=async e=>{const b=e.target.closest('[data-boardbutton]');if(b)try{await invokeButton(b.dataset.boardbutton,null)}catch(err){toast(err.body&&err.body.error||err.message)}};
}

async function invokeButton(id,cardId,args){
  const body={...(args||{}),...(cardId?{card:cardId}:{})};
  try{
    const r=await api('/api/projects/'+SEL+'/buttons/'+encodeURIComponent(id),{method:'POST',body:JSON.stringify(body)});
    await reloadOrg();
    if(cardId)setTimeout(()=>openCard(cardId,'card'),0);
    toast((r.changed||[]).length+' card(s) changed by '+id+'.');
    return r;
  }catch(err){
    const wip=/WIP justification|WIP overflow/i.test(err.message);
    if(!wip)throw err;
    const denied=/denies WIP overflow/i.test(err.message);
    if(denied&&!IS_OWNER){toast(err.message);return null}
    formModal('Run '+id,[{name:'reason',label:denied?'owner override justification':'WIP justification',required:true}],'run',async d=>{
      await invokeButton(id,cardId,{wipReason:d.reason,...(denied?{force:true}:{})});
    });
    return null;
  }
}

function syncSearchControls(b){
  const select=$('#savedsearch');if(!select)return;
  const filters=(b&&b.filters)||[];
  const sig=filters.map(f=>f.id+'\u0000'+f.name+'\u0000'+f.query).join('\u0001');
  if(select.dataset.sig!==sig){
    select.innerHTML='<option value="">saved filters</option>'+filters.map(f=>'<option value="'+esc(f.id)+'">'+esc(f.name)+'</option>').join('');
    select.dataset.sig=sig;
  }
  if(SEARCH_SAVED&&!filters.some(f=>f.id===SEARCH_SAVED)){SEARCH_SAVED='';SEARCH_IDS=null}
  select.value=SEARCH_SAVED;
  const del=$('#delfilter');if(del)del.disabled=!SEARCH_SAVED;
  const clear=$('#clearsearch');if(clear)clear.disabled=!(SEARCH_QUERY||SEARCH_SAVED);
}
function paintBoard(){
  const v=$('#view');if(!v||!BOARD)return;
  patchView(v,boardHtml(BOARD));
  if(LAYOUT==='kanban')requestAnimationFrame(()=>drawRelations(BOARD));
}
function searchStatus(message){const s=$('#searchstatus');if(s)s.textContent=message||''}
async function runSearch(){
  const seq=++SEARCH_SEQ,pid=SEL;
  const saved=SEARCH_SAVED,query=SEARCH_QUERY.trim();
  if(!saved&&!query){SEARCH_IDS=null;searchStatus('');syncSearchControls(BOARD);paintBoard();return}
  searchStatus('searching…');
  try{
    const path='/api/projects/'+pid+'/search?'+(saved?'saved='+encodeURIComponent(saved):'q='+encodeURIComponent(query));
    const cards=await api(path);
    if(seq!==SEARCH_SEQ||pid!==SEL)return;
    SEARCH_IDS=new Set(cards.map(c=>c.id));
    searchStatus(cards.length+' match'+(cards.length===1?'':'es'));
    syncSearchControls(BOARD);paintBoard();
  }catch(err){if(seq===SEARCH_SEQ&&pid===SEL)searchStatus(err.message)}
}
function wireSearchControls(){
  const input=$('#cardsearch'),saved=$('#savedsearch');if(!input||!saved)return;
  input.oninput=()=>{
    SEARCH_QUERY=input.value;SEARCH_SAVED='';saved.value='';
    if(SEARCH_TIMER)clearTimeout(SEARCH_TIMER);
    SEARCH_TIMER=setTimeout(runSearch,180);
    syncSearchControls(BOARD);
  };
  input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();if(SEARCH_TIMER)clearTimeout(SEARCH_TIMER);runSearch()}};
  saved.onchange=()=>{SEARCH_SAVED=saved.value;SEARCH_QUERY='';input.value='';runSearch()};
  const clear=$('#clearsearch');if(clear)clear.onclick=()=>{
    if(SEARCH_TIMER)clearTimeout(SEARCH_TIMER);
    SEARCH_QUERY='';SEARCH_SAVED='';SEARCH_IDS=null;input.value='';saved.value='';syncSearchControls(BOARD);paintBoard();input.focus();searchStatus('');
  };
  const save=$('#savefilter');if(save)save.onclick=()=>{
    const current=SEARCH_QUERY.trim();
    if(!current){toast('Type a query before saving it.');input.focus();return}
    formModal('Save filter',[
      {name:'id',label:'id (lowercase letters, numbers, hyphens)',required:true},
      {name:'name',label:'name',required:true},
      {name:'query',label:'query',required:true,value:current},
    ],'save filter',async d=>{
      await api('/api/projects/'+SEL+'/filters',{method:'POST',body:JSON.stringify({id:d.id,name:d.name,query:d.query})});
      SEARCH_QUERY='';SEARCH_SAVED=d.id;SEARCH_IDS=null;BOARD=null;
      await refreshBoard();await runSearch();
    });
  };
  const del=$('#delfilter');if(del)del.onclick=()=>{
    const id=SEARCH_SAVED;if(!id)return;
    confirmModal('Delete saved filter','Delete <b>'+esc(id)+'</b>? Existing feed capabilities scoped to it will stop resolving.','delete filter',async()=>{
      await api('/api/projects/'+SEL+'/filters/'+encodeURIComponent(id),{method:'DELETE'});
      SEARCH_SAVED='';SEARCH_IDS=null;BOARD=null;await refreshBoard();
    });
  };
}
// Create a card on the selected board. A lane argument pre-selects the column
// whose plus was clicked; leaving it undefined lets the board choose its own
// todo lane, exactly as the CLI's card add does. (No backticks in here: this
// whole script lives inside a TypeScript template literal.)
function newCard(lane){
  if(!CAN_WRITE)return;
  const defs=(BOARD&&BOARD.fields)||[];
  const templates=(BOARD&&BOARD.templates)||[];
  const target=(BOARD&&BOARD.lanes||[]).find(l=>l.id===lane)||((BOARD&&BOARD.lanes||[]).find(l=>l.canonical==='todo'));
  const overflow=!!target&&target.wip!=null&&target.cards.length>=target.wip;
  if(overflow&&target.wipMode==='deny'&&!IS_OWNER){toast(target.name+' is at its WIP limit. Only an owner can override it.');return}
  const fields=(templates.length?[{name:'template',label:'template (optional)',type:'select',options:[{value:'',label:'none'}].concat(templates.map(t=>({value:t.id,label:t.name})))}]:[]).concat([
    {name:'title',label:'title',required:true},
    {name:'priority',label:'priority (p0-p3, optional)'},
    {name:'labels',label:'labels (comma separated, optional)'},
    {name:'assignee',label:'accountable assignee (username, optional)'},
    {name:'delegate',label:'executing delegate (bot username, optional)'},
    {name:'start',label:'start (YYYY-MM-DD or UTC datetime)'},
    {name:'due',label:'due (YYYY-MM-DD or UTC datetime)'},
    {name:'reminders',label:'reminders before due (minutes, comma separated)'},
    {name:'repeat_every',label:'repeat every (empty for no recurrence)',type:'number'},
    {name:'repeat_unit',label:'repeat unit',type:'select',options:[{value:'day',label:'days'},{value:'week',label:'weeks'},{value:'month',label:'months'}]},
    {name:'repeat_from',label:'next dates from',type:'select',options:[{value:'due',label:'the prior due date'},{value:'completion',label:'completion time'}]},
    {name:'snooze',label:'snooze until (YYYY-MM-DD or UTC datetime)'},
    {name:'estimate',label:'estimate (positive points)',type:'number'},
    {name:'hill',label:'hill position (0–100, optional)',type:'number'},
    {name:'evergreen',label:'aging signal',type:'select',options:[{value:'',label:'normal'},{value:'true',label:'evergreen (hide aging)'}]},
    {name:'cover_color',label:'cover color (#RGB or #RRGGBB)'},
  ]).concat(overflow&&target.wipMode!=='allow'?[{name:'wipReason',label:(target.wipMode==='deny'?'owner override':'WIP')+' justification',required:true}]:[]).concat(customFormFields(defs,[]));
  formModal('New card',fields,'create',async d=>{
    const labels=d.labels?d.labels.split(',').map(x=>x.trim()).filter(Boolean):undefined;
    const reminders=d.reminders?d.reminders.split(',').map(x=>Number(x.trim())):undefined;
    const repeat=d.repeat_every?{every:Number(d.repeat_every),unit:d.repeat_unit,from:d.repeat_from}:undefined;
    const r=await api('/api/projects/'+SEL+'/cards',{method:'POST',body:JSON.stringify({
      title:d.title,template:d.template||undefined,lane:lane||undefined,priority:d.priority||undefined,labels:labels,
      assignee:d.assignee||undefined,delegate:d.delegate||undefined,start:d.start||undefined,due:d.due||undefined,
      reminders:reminders,repeat:repeat,snooze:d.snooze||undefined,wipReason:d.wipReason||undefined,
      force:overflow&&target.wipMode==='deny'&&IS_OWNER,
      estimate:d.estimate?Number(d.estimate):undefined,evergreen:d.evergreen===''?undefined:d.evergreen==='true',
      hill:d.hill===''?undefined:Number(d.hill),
      cover_color:d.cover_color||undefined,fields:customPayload(defs,d,false)})});
    await reloadOrg();
    if(r&&r.id)openCard(r.id,'card');
  });
}
function quickCards(){
  formModal('Quick add',[{name:'text',label:'one card per line · *label @owner !p1 tomorrow ^3 ~template · indent for subtask',type:'textarea',rows:10,required:true}],'create cards',async d=>{
    const r=await api('/api/projects/'+SEL+'/cards/quick',{method:'POST',body:JSON.stringify({text:d.text})});
    await reloadOrg();BOARD=null;refreshBoard();
    if(r&&r.cards&&r.cards.length)toast('Created '+r.cards.length+' card(s).');
  });
}
function bulkCardsUi(){
  formModal('Bulk action',[
    {name:'ids',label:'card ids (comma separated)',required:true},
    {name:'kind',label:'action',type:'select',options:[{value:'move',label:'move'},{value:'close',label:'close'},{value:'label',label:'label'}]},
    {name:'to',label:'target lane for move'},
    {name:'reason',label:'close reason (optional)'},
    {name:'wipReason',label:'WIP justification (when the target lane requires one)'},
    ...(IS_OWNER?[{name:'force',label:'owner override',type:'select',options:[{value:'',label:'do not force'},{value:'true',label:'force strict/WIP rules'}]}]:[]),
    {name:'add',label:'labels to add (comma separated)'},
    {name:'remove',label:'labels to remove (comma separated)'},
  ],'apply',async d=>{
    const split=v=>v?v.split(',').map(x=>x.trim()).filter(Boolean):undefined;
    const action={kind:d.kind,to:d.to||undefined,reason:d.reason||undefined,wipReason:d.wipReason||undefined,
      force:d.force==='true',add:split(d.add),remove:split(d.remove)};
    const r=await api('/api/projects/'+SEL+'/cards/bulk',{method:'POST',body:JSON.stringify({ids:split(d.ids)||[],action})});
    await reloadOrg();BOARD=null;refreshBoard();toast('Changed '+((r.changed||[]).length)+' card(s).');
  });
}
function customFormFields(defs,values){
  const current=new Map((values||[]).map(v=>[v.id,v.value]));
  return defs.map(f=>{
    const raw=current.has(f.id)?current.get(f.id):'';
    const value=Array.isArray(raw)?raw.join(', '):raw===true?'true':raw===false?'false':raw??'';
    const base={name:'cf_'+f.id,label:f.name+' · '+f.type,value:value};
    if(f.type==='checkbox')return {...base,type:'select',options:[{value:'',label:'unset'},{value:'true',label:'true'},{value:'false',label:'false'}]};
    if(f.type==='select')return {...base,type:'select',options:[{value:'',label:'unset'}].concat((f.options||[]).map(o=>({value:o,label:o})))};
    if(f.type==='number')return {...base,type:'number'};
    if(f.type==='url')return {...base,type:'url'};
    if(f.type==='multi-select')return {...base,label:f.name+' · choices, comma separated'};
    return base;
  });
}
function customPayload(defs,data,clear){
  const out={};
  for(const f of defs){
    const raw=data['cf_'+f.id];
    if(raw===''){if(clear)out[f.id]=null;continue}
    if(f.type==='number')out[f.id]=Number(raw);
    else if(f.type==='checkbox')out[f.id]=raw==='true';
    else if(f.type==='multi-select')out[f.id]=raw.split(',').map(x=>x.trim()).filter(Boolean);
    else out[f.id]=raw;
  }
  return out;
}
// What art this card shows. An explicit cover wins; otherwise a viewer may
// substitute the first previewable attachment, but only when the card has not
// suppressed art (cover: none arrives as coverAuto false, since cover itself is
// null in both cases and cannot tell them apart). No backticks in here: this
// whole script lives inside a TypeScript template literal.
function hostOf(u){try{return new URL(u,location.href).hostname.replace(/^www\./,'')}catch{return 'link'}}
function youtubeLink(u){const h=hostOf(u).replace(/\.$/,'');return h==='youtube.com'||h==='m.youtube.com'||h==='music.youtube.com'||h==='youtu.be'||h==='youtube-nocookie.com'}
function coverOf(c){
  if(c.cover)return imageOk(c.cover)?c.cover:null;
  if(!c.coverAuto)return null;
  const ps=c.previews||[];
  const p=ps.find(x=>youtubeLink(x.url))||ps[0];
  return p&&imageOk(p.image)?p.image:null;
}
function badge(ic,txt,cls){return '<span class="'+(cls||'')+'">'+ic+(txt!==undefined?' '+txt:'')+'</span>'}
function fieldText(v){return Array.isArray(v)?v.join(', '):v===true?'yes':v===false?'no':String(v)}
function labelBadge(l){
  return '<span class="lbl" style="--lc:'+esc(l.color||'var(--grid)')+'" title="'+esc(l.group?l.group+': '+l.value:l.id)+'">#'+esc(l.value||l.id)+'</span>';
}
function cardTagBadges(c){
  const details=c.labelDetails||[];
  const tags=details.length
    ?details.map(l=>({html:labelBadge(l),text:'#'+(l.value||l.id)}))
    :(c.labels||[]).map(l=>({html:'<span>#'+esc(l)+'</span>',text:'#'+l}));
  const visible=tags.slice(0,THEME.cardTagLimit),hidden=tags.slice(THEME.cardTagLimit);
  const out=visible.map(t=>t.html);
  if(hidden.length)out.push('<span class="moretags" title="'+esc(hidden.map(t=>t.text).join(', '))+'">+'+hidden.length+' more</span>');
  return out;
}
function blockerOf(c){
  return ((BOARD&&BOARD.blockers)||[]).find(b=>b.id===c.blocker)||{id:c.blocker,name:c.blocker,color:null};
}
function dueFace(c){
  const d=c.metrics&&c.metrics.due;if(!d||d.status==='complete')return null;
  const text=d.status==='overdue'?Math.abs(d.days)+'d late':d.status==='today'?'due today':d.days+'d';
  return '<span class="due-'+d.status+'" title="due '+esc(c.due)+'">◷ '+text+'</span>';
}
function faceBadges(b,c){
  const ready=new Set(b.ready||[]),items=[];
  if(c.priority)items.push('<span class="'+(c.priority==='p0'?'p0':c.priority==='p1'?'p1':'')+'">'+esc(c.priority)+'</span>');
  if(c.blocked){const bd=blockerOf(c);items.push(c.blocker
    ?'<span class="namedblk" style="--blocker-color:'+esc(bd.color||'var(--st-blocked)')+'" title="'+esc(c.blocked)+'">⛔ '+esc(bd.name)+'</span>'
    :'<span class="blk" title="'+esc(c.blocked)+'">⛔ blocked</span>')}
  if(c.snooze)items.push('<span class="snoozed" title="snoozed until '+esc(c.snooze)+'">☾ snoozed</span>');
  const due=dueFace(c);if(due)items.push(due);
  if(c.metrics&&c.metrics.dueChanges)items.push('<span title="due date changed '+c.metrics.dueChanges+' time(s)">↻ '+c.metrics.dueChanges+'</span>');
  if(c.assignee)items.push('<span title="accountable assignee">@'+esc(who(c.assignee))+'</span>');
  if(c.delegate)items.push('<span title="executing delegate">⇢ @'+esc(who(c.delegate))+'</span>');
  const tagIndex=items.length;
  if(c.checklist)items.push(badge(IC.check,c.checklist.done+'/'+c.checklist.total,c.checklist.done===c.checklist.total?'ok':''));
  if(c.estimate)items.push('<span title="estimate">est '+c.estimate+'</span>');
  for(const f of c.faceFields||[])items.push('<span class="fieldface"><b>'+esc(f.name)+'</b> '+esc(fieldText(f.value))+'</span>');
  if(c.descriptionPresent)items.push(badge('≡','description'));
  if(c.comments)items.push(badge(IC.chat,c.comments));
  if(c.attachments)items.push(badge(IC.clip,c.attachments));
  if((c.watchers||[]).length)items.push(badge('◉',c.watchers.length,'watching'));
  if(c.voteCount)items.push(badge('▲',c.voteCount,'votes'));
  if(c.boostCount)items.push(badge('✦',c.boostCount,'boosts'));
  const s=c.metrics&&c.metrics.stagnation;if(s&&s.dots)items.push('<span title="'+s.days+' cumulative days in lane">'+('●'.repeat(s.dots))+'</span>');
  if(ready.has(c.id))items.push('<span class="ready bare">▶ ready</span>');
  const shown=items.slice(0,10);shown.splice(tagIndex,0,...cardTagBadges(c));
  return shown.join('');
}
function cardHtml(b,c){
  const board=c.type==='board';
  const age=c.metrics&&c.metrics.agingLevel||0;
  return '<div class="card '+(c.blocked?'blocked ':'')+(c.blocker?'namedblocked ':'')+(c.coverColor?'has-color ':'')+(age?'age-'+age:'')+'"'+(c.coverColor?' style="--cover-color:'+esc(c.coverColor)+'"':'')+' data-card="'+esc(c.id)+'" tabindex="0" role="button"'
    +(RO?'':' aria-keyshortcuts="Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown"')+'>'
    +((cov=>cov?'<img class="art" src="'+esc(cov)+'" alt="" loading="lazy" referrerpolicy="no-referrer">':'')(coverOf(c)))
    +'<div class="inner"><div class="cid">'+esc(c.id)+'</div><div class="t">'+esc(c.title)+'</div>'
    +'<div class="badges">'+faceBadges(b,c)+'</div>'
    +((c.checklistPreview||[]).length?'<div class="previewtasks">'+c.checklistPreview.slice(0,2).map(i=>'<span title="'+esc(i.section)+'">'+esc(i.text)+'</span>').join('')+'</div>':'')
    +(board?'<div class="subboard"><button data-goto="'+esc(c.child??'')+'" '+(c.child==null||RO?'disabled':'')+'>'+IC.open+' board</button>'
      +statechip(c.state)
      +(c.childProgress!=null?'<div class="mini" title="'+pct(c.childProgress)+'"><i style="width:'+Math.round((c.childProgress||0)*100)+'%"></i></div>':'')
      +'</div>':'')
    +'</div></div>';
}
function colsHtml(b){
  return '<div class="cols" style="margin-top:12px"><svg id="relation-overlay" class="relsvg" aria-hidden="true"></svg>'+b.lanes.map(lane=>{
    const cards=SEARCH_IDS===null?lane.cards:lane.cards.filter(c=>SEARCH_IDS.has(c.id));
    const n=lane.cards.length;
    const wip=lane.wip!=null?'<span class="'+(n>lane.wip?'wipbad':'n')+'">'+n+'/'+lane.wip+'</span><span class="wipmode">'+esc(lane.wipMode||'allow')+'</span>':'<span class="n">'+n+'</span>';
    const estimateValue=SEARCH_IDS===null?lane.estimate:cards.reduce((sum,c)=>sum+(c.estimate||0),0);
    const estimate=estimateValue?'<span class="n">est '+estimateValue+'</span>':'';
    let body='';
    if(lane.substates.length){
      // Every substate gets a group, empty ones included: a strict lane must
      // be entered at its first substate, which is very often the empty one,
      // so hiding it would hide the only legal place to drop.
      for(const sub of lane.substates){
        const cs=cards.filter(c=>c.substate===sub||(sub===lane.substates[0]&&c.substate==null));
        body+='<div class="subgroup" data-lane="'+esc(lane.id)+'" data-sub="'+esc(sub)+'">'
          +'<div class="sub-h">· '+esc(sub)+'</div>'+cs.map(c=>cardHtml(b,c)).join('')+'</div>';
      }
    }else body=cards.map(c=>cardHtml(b,c)).join('');
    const subscribed=!!ME&&(lane.subscribers||[]).includes(ME.username);
    const add=!RO?'<footer class="lanefoot"><button type="button" class="laneadd" data-addcard="'+esc(lane.id)+'" title="add a card to '+esc(lane.name)+'" aria-label="add a card to '+esc(lane.name)+'">+ add card</button>'
      +'<button type="button" class="lanesub" data-lanesub="'+esc(lane.id)+'" data-on="'+subscribed+'" aria-pressed="'+subscribed+'" title="'+(subscribed?'unsubscribe from':'subscribe to')+' '+esc(lane.name)+'">'+(subscribed?'◉':'○')+' follow</button></footer>':'';
    return '<section class="col" data-lane="'+esc(lane.id)+'"><h3>'+esc(lane.name)+' '+wip+' '+estimate+'</h3>'
      +'<div class="deck" data-lane="'+esc(lane.id)+'">'+(body||'<div class="empty">·</div>')+'</div>'+add+'</section>';
  }).join('')+'</div>';
}
function visibleCards(b){
  const cards=(b.lanes||[]).flatMap(l=>l.cards||[]);
  return SEARCH_IDS===null?cards:cards.filter(c=>SEARCH_IDS.has(c.id));
}
function cardField(c,id){const f=(c.fields||[]).find(x=>x.id===id);return f?f.value:null}
function uniqValues(values,label){
  const seen=new Set(),out=[];
  for(const raw of values){if(raw===null||raw===undefined||raw==='')continue;const id=String(raw);if(seen.has(id))continue;seen.add(id);out.push({id:id,label:label?label(id):id})}
  return out.sort((a,z)=>a.label.localeCompare(z.label));
}
function axisDefs(b){
  const cards=(b.lanes||[]).flatMap(l=>l.cards||[]),defs=[];
  defs.push({id:'lane',label:'lane',kind:'lane',values:(b.lanes||[]).map(l=>({id:l.id,label:l.name}))});
  const people=[...DIR.keys()];
  defs.push({id:'assignee',label:'assignee',kind:'assignee',values:uniqValues(people.concat(cards.map(c=>c.assignee)),who)});
  defs.push({id:'delegate',label:'delegate',kind:'delegate',values:uniqValues(people.concat(cards.map(c=>c.delegate)),who)});
  defs.push({id:'priority',label:'priority',kind:'priority',values:['p0','p1','p2','p3'].map(id=>({id:id,label:id}))});
  const groups=new Map();
  for(const c of cards)for(const l of c.labelDetails||[])if(l.group){if(!groups.has(l.group))groups.set(l.group,new Set());groups.get(l.group).add(l.value)}
  for(const l of b.labels||[]){const at=l.id.indexOf('/');if(at>0&&at<l.id.length-1){const g=l.id.slice(0,at),v=l.id.slice(at+1);if(!groups.has(g))groups.set(g,new Set());groups.get(g).add(v)}}
  for(const [group,values] of [...groups].sort((a,z)=>a[0].localeCompare(z[0])))defs.push({id:'label:'+group,label:'label · '+group,kind:'label',group:group,values:uniqValues([...values])});
  for(const f of b.fields||[]){
    if(!['select','person','checkbox'].includes(f.type))continue;
    let values=f.type==='select'?(f.options||[]).map(id=>({id:id,label:id}))
      :f.type==='checkbox'?[{id:'true',label:'yes'},{id:'false',label:'no'}]
      :uniqValues(people.concat(cards.map(c=>cardField(c,f.id))),who);
    defs.push({id:'field:'+f.id,label:'field · '+f.name,kind:'field',field:f,values:values});
  }
  return defs;
}
function axisValue(axis,c){
  if(axis.kind==='lane')return c.lane||'';
  if(axis.kind==='assignee'||axis.kind==='delegate'||axis.kind==='priority')return c[axis.kind]||'';
  if(axis.kind==='label'){const l=(c.labelDetails||[]).find(x=>x.group===axis.group);return l?String(l.value):''}
  const value=cardField(c,axis.field.id);return value===null||value===undefined||value===''?'':String(value);
}
function chosenAxis(b,id){const defs=axisDefs(b);return defs.find(a=>a.id===id)||defs[0]}
function syncViewControls(b){
  const layout=$('#boardlayout');if(layout)layout.value=LAYOUT;
  const ctl=$('#axisctl');if(!ctl||!b)return;
  const grouped=LAYOUT==='grouped'||LAYOUT==='swimlane';ctl.hidden=!grouped;if(!grouped)return;
  const axes=axisDefs(b),wanted=LAYOUT==='grouped'?GROUP_AXIS:SWIM_AXIS;
  const selected=axes.some(a=>a.id===wanted)?wanted:(LAYOUT==='grouped'?'assignee':'assignee');
  if(LAYOUT==='grouped')GROUP_AXIS=selected;else SWIM_AXIS=selected;
  const sig=axes.map(a=>a.id+'\u0000'+a.label).join('\u0001');
  if(ctl.dataset.sig!==sig){ctl.innerHTML=axes.map(a=>'<option value="'+esc(a.id)+'">'+esc(a.label)+'</option>').join('');ctl.dataset.sig=sig}
  ctl.value=selected;
}
function tableValue(c,key){
  if(key==='title')return c.title||'';if(key==='state')return c.state||'';if(key==='lane')return c.position||c.lane||'';
  if(key==='assignee')return c.assignee||'';if(key==='due')return c.due||'';if(key==='estimate')return c.estimate??-1;
  if(key==='hill')return c.hill??-1;return c.id||'';
}
function tableHtml(b){
  const cards=[...visibleCards(b)].sort((a,z)=>{const av=tableValue(a,TABLE_SORT),zv=tableValue(z,TABLE_SORT);const n=typeof av==='number'&&typeof zv==='number'?av-zv:String(av).localeCompare(String(zv),undefined,{numeric:true});return TABLE_DESC?-n:n});
  const th=(key,label)=>'<th><button data-sort="'+key+'" aria-label="sort by '+label+'">'+label+(TABLE_SORT===key?(TABLE_DESC?' ↓':' ↑'):'')+'</button></th>';
  return '<div class="cardtable"><table class="list"><thead><tr>'+th('id','id')+th('title','title')+th('state','state')+th('lane','position')+th('assignee','assignee')
    +'<th>delegate</th><th>priority</th>'+th('due','due')+th('estimate','estimate')+th('hill','hill')+'<th>labels</th><th>idle</th></tr></thead><tbody>'
    +(cards.length?cards.map(c=>'<tr data-card="'+esc(c.id)+'" tabindex="0" role="button"><td class="mono">'+esc(c.id)+'</td><td class="titlecell">'+esc(c.title)+'</td><td>'+statechip(c.state)+'</td><td class="mono">'+esc(c.position)+'</td>'
      +'<td>'+esc(c.assignee?who(c.assignee):'—')+'</td><td>'+esc(c.delegate?who(c.delegate):'—')+'</td><td>'+esc(c.priority||'—')+'</td><td class="mono">'+esc(c.due||'—')+'</td><td>'+esc(c.estimate??'—')+'</td><td>'+esc(c.hill??'—')+'</td>'
      +'<td class="labels-cell">'+(c.labelDetails||[]).map(l=>'#'+esc(l.value)).join(' ')+'</td><td>'+esc(c.metrics&&c.metrics.idleDays!=null?c.metrics.idleDays+'d':'—')+'</td></tr>').join('')
      :'<tr><td colspan="12" class="empty">no matching cards</td></tr>')+'</tbody></table></div>';
}
function groupedHtml(b){
  const cards=visibleCards(b),axis=chosenAxis(b,GROUP_AXIS);
  const values=axis.kind==='lane'?(axis.values||[]):[{id:'',label:'unset'}].concat(axis.values||[]);
  return '<div class="axiscols" data-group-axis="'+esc(axis.id)+'">'+values.map(v=>{
    const cs=cards.filter(c=>axisValue(axis,c)===v.id);
    return '<section class="axiscol" data-axis-value="'+esc(v.id)+'"><h3>'+esc(v.label)+' <span class="n">'+cs.length+'</span></h3><div class="deck">'+(cs.length?cs.map(c=>cardHtml(b,c)).join(''):'<div class="empty">drop here</div>')+'</div></section>';
  }).join('')+'</div>';
}
function swimlaneHtml(b){
  const cards=visibleCards(b),axis=chosenAxis(b,SWIM_AXIS),lanes=b.lanes||[];
  let values=(axis.kind==='lane'?(axis.values||[]):[{id:'',label:'unset'}].concat(axis.values||[])).filter(v=>cards.some(c=>axisValue(axis,c)===v.id));
  if(!values.length)values=[{id:'',label:'unset'}];
  const cols='grid-template-columns:160px repeat('+lanes.length+',240px)';
  let out='<div class="swimwrap"><div class="swim" style="'+cols+'"><div class="swimhead">'+esc(axis.label)+'</div>'
    +lanes.map(l=>'<div class="swimhead">'+esc(l.name)+'</div>').join('');
  for(const v of values){
    const row=cards.filter(c=>axisValue(axis,c)===v.id);out+='<div class="swimlabel">'+esc(v.label)+'<small>'+row.length+' card'+(row.length===1?'':'s')+'</small></div>';
    for(const lane of lanes){const cs=row.filter(c=>c.lane===lane.id);out+='<div class="swimcell" data-lane="'+esc(lane.id)+'">'+(cs.length?cs.map(c=>cardHtml(b,c)).join(''):'<span class="empty">·</span>')+'</div>'}
  }
  return out+'</div></div>';
}
function isoDay(value){const s=String(value||'').slice(0,10);return /^\\d{4}-\\d{2}-\\d{2}$/.test(s)?s:null}
function utcDay(value){const s=isoDay(value);return s?Math.floor(Date.parse(s+'T00:00:00Z')/86400000):null}
function dayIso(day){return new Date(day*86400000).toISOString().slice(0,10)}
function calendarHtml(b){
  const cards=visibleCards(b).filter(c=>isoDay(c.due));
  const now=new Date(),defaultMonth=now.toISOString().slice(0,7);if(!CAL_MONTH)CAL_MONTH=defaultMonth;
  let parts=CAL_MONTH.split('-').map(Number),year=parts[0],month=parts[1]-1;
  if(!Number.isInteger(year)||month<0||month>11){CAL_MONTH=defaultMonth;parts=CAL_MONTH.split('-').map(Number);year=parts[0];month=parts[1]-1}
  const first=Math.floor(Date.UTC(year,month,1)/86400000),offset=new Date(first*86400000).getUTCDay(),start=first-offset,today=now.toISOString().slice(0,10);
  const monthName=new Intl.DateTimeFormat(undefined,{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(Date.UTC(year,month,1)));
  let out='<div class="calendar"><div class="calbar"><button data-cal="-1" aria-label="previous month">←</button><h3>'+esc(monthName)+'</h3><button data-cal="today">today</button><button data-cal="1" aria-label="next month">→</button></div><div class="calgrid">'
    +['sun','mon','tue','wed','thu','fri','sat'].map(d=>'<div class="caldayname">'+d+'</div>').join('');
  for(let i=0;i<42;i++){
    const day=start+i,date=dayIso(day),inMonth=new Date(day*86400000).getUTCMonth()===month,items=cards.filter(c=>isoDay(c.due)===date);
    out+='<div class="calday '+(inMonth?'':'out ')+(date===today?'today':'')+'"><div class="caldate">'+esc(date.slice(8))+'</div>'
      +items.map(c=>'<button class="calcard" style="--state-color:var(--st-'+esc(c.state)+')" data-card="'+esc(c.id)+'" title="'+esc(c.id+' '+c.title+' · '+c.due)+'">'+esc(c.id+' '+c.title)+'</button>').join('')+'</div>';
  }
  return out+'</div></div>';
}
function timelineHtml(b){
  const cards=visibleCards(b).filter(c=>isoDay(c.start)||isoDay(c.due));
  if(!cards.length)return '<div class="empty" style="margin-top:12px">No matching cards have a start or due date.</div>';
  const spans=cards.map(c=>{const s=utcDay(c.start),d=utcDay(c.due),a=s??d,z=d??s;return {c:c,start:Math.min(a,z),end:Math.max(a,z)}});
  let min=Math.min(...spans.map(x=>x.start)),max=Math.max(...spans.map(x=>x.end));if(min===max){min--;max++}const range=max-min+1;
  const tick=n=>dayIso(Math.round(min+(range-1)*n));
  return '<div class="timeline"><div class="tlaxis"><span>'+tick(0)+'</span><span>'+tick(.25)+'</span><span>'+tick(.5)+'</span><span>'+tick(.75)+'</span><span>'+tick(1)+'</span></div>'
    +spans.sort((a,z)=>a.start-z.start||a.c.id.localeCompare(z.c.id,undefined,{numeric:true})).map(x=>{const left=(x.start-min)/range*100,width=Math.max(100/range,(x.end-x.start+1)/range*100);
      return '<div class="tlrow"><button class="tllabel" data-card="'+esc(x.c.id)+'"><code>'+esc(x.c.id)+'</code> '+esc(x.c.title)+'</button><div class="tltrack"><button class="tlbar" data-open-card="'+esc(x.c.id)+'" style="left:'+left+'%;width:'+width+'%;--state-color:var(--st-'+esc(x.c.state)+')" aria-label="'+esc(x.c.id+' '+x.c.title+', '+dayIso(x.start)+' through '+dayIso(x.end))+'"></button></div></div>'}).join('')+'</div>';
}
function avg(values){return values.length?Math.round(values.reduce((a,n)=>a+n,0)/values.length*10)/10:null}
function metricsHtml(b){
  const cards=visibleCards(b),active=cards.filter(c=>!['done','archive'].includes(c.state)),done=cards.filter(c=>c.state==='done'),overdue=cards.filter(c=>c.metrics&&c.metrics.due&&c.metrics.due.status==='overdue');
  const cycle=cards.map(c=>c.metrics&&c.metrics.cycleDays).filter(n=>n!=null),lead=cards.map(c=>c.metrics&&c.metrics.leadDays).filter(n=>n!=null),idle=active.map(c=>c.metrics&&c.metrics.idleDays).filter(n=>n!=null);
  const filtered=SEARCH_IDS!==null,boardThroughput=(b.flow&&b.flow.throughput)||[];
  const completionDates=filtered?cards.map(c=>c.metrics&&c.metrics.completedAt&&c.metrics.completedAt.slice(0,10)).filter(Boolean):[];
  const throughput=filtered?boardThroughput.map(x=>({date:x.date,count:completionDates.filter(date=>date===x.date).length})):boardThroughput;
  const last7=throughput.slice(-7).reduce((n,x)=>n+x.count,0),last30=throughput.reduce((n,x)=>n+x.count,0),wip=(b.lanes||[]).filter(l=>l.wip!=null&&l.cards.length>l.wip).length;
  const metric=(value,label)=>'<div class="metric"><b>'+esc(value)+'</b><span>'+esc(label)+'</span></div>';
  const max=Math.max(1,...throughput.map(x=>x.count));
  const bars='<div class="bars" role="img" aria-label="'+esc('Daily throughput: '+(throughput.length?throughput.map(x=>x.date+' '+x.count).join(', '):'no completions'))+'">'+throughput.map(x=>'<i style="height:'+(x.count/max*100)+'%" title="'+esc(x.date+': '+x.count)+'"></i>').join('')+'</div>';
  const flow=(b.flow&&b.flow.cumulativeFlow)||[],flowMax=Math.max(1,...flow.map(x=>ORDER.reduce((n,s)=>n+(x.distribution[s]||0),0)));
  const cfbars='<div class="cfbars" role="img" aria-label="'+esc('Cumulative flow by state for '+flow.length+' day'+(flow.length===1?'':'s'))+'">'+flow.map(x=>'<div class="cfbar" title="'+esc(x.date)+'">'+ORDER.map(s=>{const n=x.distribution[s]||0;return n?'<i style="height:'+(n/flowMax*100)+'%;background:var(--st-'+s+')"></i>':''}).join('')+'</div>').join('')+'</div>';
  const blockerTotals={};
  if(filtered){for(const c of cards)for(const [id,days] of Object.entries(c.metrics&&c.metrics.blockerDays||{}))blockerTotals[id]=(blockerTotals[id]||0)+days}
  else Object.assign(blockerTotals,(b.flow&&b.flow.blockerDays)||{});
  const blockers=Object.entries(blockerTotals).sort((a,z)=>z[1]-a[1]);
  const age=[0,1,2,3].map(level=>[level,active.filter(c=>(c.metrics&&c.metrics.agingLevel||0)===level).length]);
  return (filtered?'<p class="hillnote">Card metrics reflect the active filter. Cumulative flow and WIP breaches remain whole-board measures.</p>':'')
    +'<div class="metricgrid">'+metric(cards.length,'visible cards')+metric(active.length,'active')+metric((b.ready||[]).filter(id=>cards.some(c=>c.id===id)).length,'ready')+metric(overdue.length,'overdue')+metric(last7,'completed · 7d')+metric(last30,'completed · 30d')+metric(avg(cycle)??'—','average cycle days')+metric(avg(lead)??'—','average lead days')+metric(avg(idle)??'—','average active idle days')+metric(wip,'board WIP breaches')+metric(done.reduce((n,c)=>n+(c.estimate||0),0),'completed estimate')+'</div>'
    +'<div class="chartgrid"><section class="chart"><h3>throughput · last 30 UTC days'+(filtered?' · visible cards':'')+'</h3>'+bars+'</section><section class="chart"><h3>cumulative flow · last 30 UTC days'+(filtered?' · whole board':'')+'</h3>'+cfbars+'</section>'
    +'<section class="chart"><h3>active-card aging</h3><div class="metriclist">'+age.map(x=>'<div><span>'+(['fresh','7+ days','14+ days','28+ days'][x[0]])+'</span><b>'+x[1]+'</b></div>').join('')+'</div></section>'
    +'<section class="chart"><h3>blocked days by named reason</h3>'+(blockers.length?'<div class="metriclist">'+blockers.map(x=>'<div><span>'+esc(x[0])+'</span><b>'+esc(x[1])+'d</b></div>').join('')+'</div>':'<div class="empty">no proven blocked intervals</div>')+'</section></div>';
}
function hillY(value){return 20+160*Math.pow((value-50)/50,2)}
function hillDotStyle(c){const v=c.hill==null?0:c.hill;return 'left:'+(4+v*.92)+'%;top:'+hillY(v)+'px;--state-color:var(--st-'+esc(c.state)+')'}
function hillHtml(b){
  const cards=visibleCards(b).filter(c=>c.type!=='board'&&!['done','archive'].includes(c.state)),plotted=cards.filter(c=>c.hill!=null);
  return '<div class="hillview"><p class="hillnote">Manual uncertainty, not automatic progress. Drag uphill while the approach is being figured out; cross the crest only when execution is understood.</p><div class="hillplot" data-hillplot>'
    +'<svg viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true"><path d="M 0 180 Q 250 20 500 20 Q 750 20 1000 180"></path></svg><i class="crest" aria-hidden="true"></i><span class="hillphase up">figuring it out · uphill</span><span class="hillphase down">making it happen · downhill</span>'
    +plotted.map(c=>RO
      ?'<span class="hilldot" style="'+hillDotStyle(c)+'" role="img" aria-label="'+esc(c.id+' '+c.title+', hill position '+c.hill)+'" title="'+esc(c.id+' '+c.title+' · '+c.hill)+'"></span>'
      :'<button class="hilldot" data-hill="'+esc(c.id)+'" style="'+hillDotStyle(c)+'" role="slider" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+c.hill+'" aria-label="'+esc(c.id+' '+c.title+', hill position '+c.hill)+'" title="'+esc(c.id+' '+c.title+' · '+c.hill)+'"></button>').join('')+'</div>'
    +'<div class="hilllegend">'+cards.map(c=>'<div class="hillitem" style="--state-color:var(--st-'+esc(c.state)+')"><i></i><button data-card="'+esc(c.id)+'">'+esc(c.id+' '+c.title)+'</button>'+(c.hill==null?(RO?'<code>unplotted</code>':'<button class="hillset" data-hill-init="'+esc(c.id)+'">plot at 0</button>'):'<code>'+c.hill+'</code>')+'</div>').join('')+'</div>'+(cards.length?'':'<div class="empty">no active task cards</div>')+'</div>';
}
function handoffTargets(){
  const here=SEL?findAny(SEL):null,targets=[];
  const walk=nodes=>{for(const node of nodes||[]){targets.push(node);walk(node.children)}};
  walk(here&&here.children);return targets;
}
function wormholesHtml(){
  const targets=RO?[]:handoffTargets();
  return targets.length?'<div class="wormrail" role="list" aria-label="nested project handoff targets"><span class="lbl">wormholes · move card to</span>'
    +targets.map(p=>'<span class="wormhole" role="listitem" data-wormhole="'+esc(p.id)+'">⇢ '+esc(p.name)+'</span>').join('')+'</div>':'';
}
/** A lost claim comes back as a structured conflict. Say what actually
 *  happened: who holds it, what it waits on, why it is parked. The server's
 *  own message carries the detail (which deps, which reason), so it rides
 *  along underneath rather than being thrown away. */
function conflictHtml(conflict,detail){
  const r=conflict&&conflict.reason;
  const lead=r==='assigned'?'<b>'+esc(who(conflict.holder))+'</b> already holds this card.'
    :r==='blocked'?'This card is parked as blocked.'
    :r==='snoozed'?'This card is snoozed until activity wakes it or its time arrives.'
    :r==='deps'?'This card is waiting on work that is not done yet.'
    :r==='not-ready'?'This card is not ready to be claimed: it sits in <b>'+esc(conflict.position||'')+'</b>.'
    :'This card cannot be claimed right now.';
  return '<p style="font-size:13px;color:var(--ink2);line-height:1.55">'+lead+'</p>'
    +(detail?'<p style="font-size:12px;color:var(--muted);margin-top:6px">'+esc(detail)+'</p>':'');
}

function moveCardUi(card,to,forceRules,after){
  if(card.blocker){toast(card.id+' is blocked by '+blockerOf(card).name+'. Unblock it before moving.');return}
  const laneId=to.split('.')[0];
  const lane=(BOARD&&BOARD.lanes||[]).find(l=>l.id===laneId);
  const overflow=!!lane&&card.lane!==lane.id&&lane.wip!=null&&lane.cards.length>=lane.wip;
  const mode=lane&&lane.wipMode||'allow';
  if(overflow&&mode==='deny'&&!IS_OWNER){toast(lane.name+' denies WIP overflow ('+(lane.cards.length+1)+'/'+lane.wip+').');return}
  const force=forceRules||(overflow&&mode==='deny');
  const send=async reason=>{
    const payload={to:to,...(force?{force:true}:{}),...(reason?{wipReason:reason}:{})};
    try{await api('/api/projects/'+SEL+'/cards/'+card.id+'/move',{method:'POST',body:JSON.stringify(payload)});await after()}
    catch(err){toast(err.message)}
  };
  if(overflow&&mode!=='allow'){
    formModal(force?'Override WIP limit':'Explain WIP overflow',[
      {name:'reason',label:force?'owner override justification':'written WIP justification',required:true},
    ],force?'force the move':'move card',d=>send(d.reason));
    return;
  }
  if(forceRules){
    confirmModal('Override the lane rules',
      'Moving '+esc(card.id)+' to <b>'+esc(to)+'</b> breaks the order this lane declares. Forcing is recorded as an override in the activity log.',
      'force the move',()=>send(''));
    return;
  }
  send('');
}

async function assignAxisUi(card,value){
  const axis=chosenAxis(BOARD,GROUP_AXIS);if(axisValue(axis,card)===value)return;
  if(axis.kind==='lane'){
    const lane=(BOARD.lanes||[]).find(l=>l.id===value);if(!lane)return;
    const to=lane.substates&&lane.substates.length?lane.id+'.'+lane.substates[0]:lane.id;
    moveCardUi(card,to,false,()=>reloadOrg());return;
  }
  const patch={};
  if(axis.kind==='assignee'||axis.kind==='delegate'||axis.kind==='priority')patch[axis.kind]=value||null;
  else if(axis.kind==='label'){
    patch.labels=(card.labels||[]).filter(id=>!(card.labelDetails||[]).some(l=>l.id===id&&l.group===axis.group));
    if(value)patch.labels.push(axis.group+'/'+value);
  }else{
    let next=value||null;if(axis.field.type==='checkbox'&&value)next=value==='true';
    patch.fields={[axis.field.id]:next};
  }
  try{await api('/api/projects/'+SEL+'/cards/'+card.id+'/edit',{method:'POST',body:JSON.stringify(patch)});await reloadOrg();toast(card.id+' · '+axis.label+' → '+(value||'unset'))}
  catch(err){toast(err.message)}
}

// ---- drag to move ----
// Pointer events rather than HTML5 drag-and-drop: the same code path then
// covers mouse, pen and touch. Touch needs a press-and-hold to lift a card,
// or every attempt to scroll a column would start a drag instead.
let DRAG=null,PRESS=null,DRAG_ENDED=0;
const HOLD_MS=260,SLOP=6;

// Where may this card legally land? Mirrors opMove: a strict lane must be
// entered at its first substate and stepped through one at a time; everything
// else is open. Computing it here means an illegal target simply refuses the
// drop, instead of the drop failing afterwards with a message.
function dropRules(b,card){
  const legal=new Map(),lanes=b.lanes||[];
  for(const lane of lanes){
    const strict=lane.order==='strict'&&lane.substates.length>0;
    if(!lane.substates.length){legal.set(lane.id+'\u0000',true);continue}
    for(const sub of lane.substates){
      let ok=true;
      if(strict){
        if(card.lane!==lane.id)ok=sub===lane.substates[0];
        else{
          const cur=lane.substates.indexOf(card.substate||lane.substates[0]);
          ok=Math.abs(cur-lane.substates.indexOf(sub))===1;
        }
      }
      legal.set(lane.id+'\u0000'+sub,ok);
    }
  }
  return legal;
}
function dragTargetAt(x,y){
  const el=document.elementFromPoint(x,y);
  if(!el)return null;
  const axis=el.closest('[data-axis-value]');
  if(axis)return {axis:axis.dataset.axisValue,el:axis};
  const wormhole=el.closest('[data-wormhole]');
  if(wormhole)return {wormhole:wormhole.dataset.wormhole,el:wormhole};
  const group=el.closest('[data-sub]');
  if(group)return {lane:group.dataset.lane,sub:group.dataset.sub,el:group};
  const col=el.closest('.col');
  if(!col)return null;
  // A lane with substates that was hit on its header: aim at the first group.
  const first=col.querySelector('[data-sub]');
  if(first)return {lane:first.dataset.lane,sub:first.dataset.sub,el:first};
  return {lane:col.dataset.lane,sub:null,el:col};
}
function dragCleanup(){
  if(PRESS&&PRESS.timer)clearTimeout(PRESS.timer);
  PRESS=null;
  if(!DRAG)return;
  // A pointerup after a drag still produces a click, which would open the
  // card you just dropped. Remember when the drag ended and let the click
  // that follows it pass through unhandled.
  DRAG_ENDED=Date.now();
  if(DRAG.ghost)DRAG.ghost.remove();
  if(DRAG.hint)DRAG.hint.remove();
  if(DRAG.src)DRAG.src.classList.remove('dragging');
  document.body.classList.remove('dragmode');
  for(const el of document.querySelectorAll('.candrop,.nodrop,.drop-on,.drop-force'))
    el.classList.remove('candrop','nodrop','drop-on','drop-force');
  DRAG=null;
}
function refuseBlockedDrag(c){if(c.blocker){toast(c.id+' is blocked by '+blockerOf(c).name+'. Unblock it before moving.');return true}return false}
function dragStart(card,ev){
  if(RO||!BOARD)return;
  const c=(BOARD.lanes||[]).flatMap(l=>l.cards).find(x=>x.id===card.dataset.card);
  if(!c)return;
  const grouped=LAYOUT==='grouped',axis=grouped?chosenAxis(BOARD,GROUP_AXIS):null;
  if((!grouped||axis.kind==='lane')&&refuseBlockedDrag(c))return;
  const rect=card.getBoundingClientRect();
  const ghost=card.cloneNode(true);
  ghost.classList.add('dragghost');ghost.removeAttribute('id');
  ghost.style.width=rect.width+'px';
  document.body.appendChild(ghost);
  const hint=document.createElement('div');
  hint.className='draghint';
  hint.textContent=grouped?'drop to change '+axis.label+' · esc cancels':IS_OWNER?'drop to move · hold over a red zone to override · esc cancels':'drop to move · esc cancels';
  document.body.appendChild(hint);
  card.classList.add('dragging');
  document.body.classList.add('dragmode');
  DRAG={id:c.id,card:c,src:card,ghost:ghost,hint:hint,legal:dropRules(BOARD,c),over:null,force:false,axis:axis};
  if(grouped){for(const col of document.querySelectorAll('[data-axis-value]'))col.classList.add('candrop');dragMove(ev);return}
  // Mark every zone once, so the whole board reads as legal or not at a glance.
  for(const g of document.querySelectorAll('[data-sub]')){
    const ok=DRAG.legal.get(g.dataset.lane+'\u0000'+g.dataset.sub);
    g.classList.add(ok?'candrop':(IS_OWNER?'candrop':'nodrop'));
    if(!ok)g.dataset.forceOnly='1';else delete g.dataset.forceOnly;
  }
  for(const col of document.querySelectorAll('.col')){
    if(col.querySelector('[data-sub]'))continue;
    col.classList.add('candrop');
  }
  for(const wormhole of document.querySelectorAll('[data-wormhole]'))wormhole.classList.add('candrop');
  dragMove(ev);
}
function dragMove(ev){
  if(!DRAG)return;
  DRAG.ghost.style.left=ev.clientX+'px';
  DRAG.ghost.style.top=ev.clientY+'px';
  const t=dragTargetAt(ev.clientX,ev.clientY);
  if(DRAG.over&&DRAG.over.el!==(t&&t.el))DRAG.over.el.classList.remove('drop-on','drop-force');
  DRAG.over=t;DRAG.force=false;
  if(!t)return;
  if(t.axis!==undefined){t.el.classList.add('drop-on');DRAG.hint.textContent='drop to set '+DRAG.axis.label+' to '+(t.axis||'unset')+' · esc cancels';return}
  if(t.wormhole){
    t.el.classList.add('drop-on');
    DRAG.hint.textContent='drop to move this card through the wormhole · esc cancels';
    return;
  }
  DRAG.hint.textContent=IS_OWNER?'drop to move · hold over a red zone to override · esc cancels':'drop to move · esc cancels';
  const key=t.lane+'\u0000'+(t.sub===null?'':t.sub);
  const ok=DRAG.legal.get(key)!==false;
  if(ok)t.el.classList.add('drop-on');
  else if(IS_OWNER){t.el.classList.add('drop-force');DRAG.force=true}
  // Auto-scroll the deck when dragging against either edge.
  const cols=$('.cols');
  if(cols){
    const r=cols.getBoundingClientRect();
    if(ev.clientX>r.right-60)cols.scrollLeft+=14;
    else if(ev.clientX<r.left+60)cols.scrollLeft-=14;
  }
}
async function dragDrop(){
  if(!DRAG)return;
  const t=DRAG.over,card=DRAG.card,force=DRAG.force;
  const id=DRAG.id;
  dragCleanup();
  if(!t)return;
  if(t.axis!==undefined){assignAxisUi(card,t.axis);return}
  if(t.wormhole){
    try{
      const r=await api('/api/projects/'+SEL+'/cards/'+id+'/transfer',{method:'POST',body:JSON.stringify({target:t.wormhole,move:true})});
      await reloadOrg();SEL=r.project;VIEW='board';BOARD=null;renderSide();renderMain();toast(id+' moved through wormhole to '+r.project);
    }catch(err){toast(err.message)}
    return;
  }
  const to=t.sub===null?t.lane:t.lane+'.'+t.sub;
  const from=card.substate?card.lane+'.'+card.substate:card.lane;
  if(to===from)return;
  moveCardUi(card,to,force,()=>reloadOrg());
}
function boardClicks(e){
  if(Date.now()-DRAG_ENDED<400)return;
  const hillInit=e.target.closest('[data-hill-init]');
  if(hillInit){const card=visibleCards(BOARD).find(c=>c.id===hillInit.dataset.hillInit);if(card&&!RO)saveHill(card,0);return}
  const sort=e.target.closest('[data-sort]');
  if(sort){if(TABLE_SORT===sort.dataset.sort)TABLE_DESC=!TABLE_DESC;else{TABLE_SORT=sort.dataset.sort;TABLE_DESC=false}paintBoard();return}
  const cal=e.target.closest('[data-cal]');
  if(cal){
    const now=new Date();
    if(cal.dataset.cal==='today')CAL_MONTH=now.toISOString().slice(0,7);
    else{const p=(CAL_MONTH||now.toISOString().slice(0,7)).split('-').map(Number),d=new Date(Date.UTC(p[0],p[1]-1+Number(cal.dataset.cal),1));CAL_MONTH=d.toISOString().slice(0,7)}
    paintBoard();return;
  }
  const ac=e.target.closest('[data-addcard]');
  if(ac){newCard(ac.dataset.addcard);e.stopPropagation();return}
  const sub=e.target.closest('[data-lanesub]');
  if(sub){
    e.stopPropagation();
    const active=sub.dataset.on!=='true';sub.disabled=true;
    api('/api/projects/'+SEL+'/lanes/'+encodeURIComponent(sub.dataset.lanesub)+'/subscribe',{method:'POST',body:JSON.stringify({active:active})})
      .then(()=>refreshBoard()).catch(err=>{sub.disabled=false;toast(err.message)});
    return;
  }
  const go=e.target.closest('[data-goto]');
  if(go&&!go.disabled){SEL=go.dataset.goto;VIEW='board';BOARD=null;renderSide();renderMain();e.stopPropagation();return}
  const el=e.target.closest('[data-card],[data-open-card]');
  if(el)openCard(el.dataset.card||el.dataset.openCard);
}
// Keyboard nav: cards are tabbable; arrows walk the deck, Enter/Space opens.
// Moving a card without a pointer. Shift+Arrow rather than a grab mode: the
// board already spends Enter and Space on opening a card, and a modeless
// binding needs no instructions to escape from. Left/right crosses lanes,
// up/down steps substates within one.
async function keyboardMove(el,dir){
  if(RO||!BOARD)return;
  const id=el.dataset.card;
  const c=(BOARD.lanes||[]).flatMap(l=>l.cards).find(x=>x.id===id);
  if(!c)return;
  const lanes=BOARD.lanes||[];
  const li=lanes.findIndex(l=>l.id===c.lane);
  if(li<0)return;
  let lane=lanes[li],sub=c.substate;
  if(dir==='left'||dir==='right'){
    const ni=li+(dir==='right'?1:-1);
    if(ni<0||ni>=lanes.length)return;
    lane=lanes[ni];
    // Entering a lane with substates lands on its first, which is also the
    // only legal entry point when that lane is strict.
    sub=lane.substates.length?lane.substates[0]:null;
  }else{
    if(!lane.substates.length)return;
    const si=lane.substates.indexOf(sub||lane.substates[0]);
    const ns=si+(dir==='down'?1:-1);
    if(ns<0||ns>=lane.substates.length)return;
    sub=lane.substates[ns];
  }
  const to=sub?lane.id+'.'+sub:lane.id;
  const from=c.substate?c.lane+'.'+c.substate:c.lane;
  if(to===from)return;
  const after=async()=>{
      await reloadOrg();
      // The card lives in another column now; put focus back on it so a run
      // of moves does not strand the keyboard at the old position.
      const again=document.querySelector('[data-card="'+id+'"]');
      if(again)again.focus();
      toast(id+' moved to '+to);
  };
  const legal=dropRules(BOARD,c).get(lane.id+'\u0000'+(sub||''))!==false;
  if(legal)return moveCardUi(c,to,false,after);
  if(!IS_OWNER)return toast(lane.id+' is strict: '+id+' can only enter at '+lane.id+'.'+lane.substates[0]);
  moveCardUi(c,to,true,after);
}
function keyboardAxisMove(el,dir){
  const card=visibleCards(BOARD).find(c=>c.id===el.dataset.card),axis=chosenAxis(BOARD,GROUP_AXIS);if(!card)return;
  const values=[{id:'',label:'unset'}].concat(axis.values||[]),at=values.findIndex(v=>v.id===axisValue(axis,card)),next=values[at+(dir==='right'?1:-1)];
  if(next)assignAxisUi(card,next.id);
}
function boardKeys(e){
  const hill=e.target.closest('[data-hill]');
  if(hill&&['ArrowLeft','ArrowRight','PageDown','PageUp','Home','End'].includes(e.key)){
    e.preventDefault();const card=visibleCards(BOARD).find(c=>c.id===hill.dataset.hill);if(!card||RO)return;
    let value=HILL_PENDING.get(SEL+'\u0000'+card.id)?.value??card.hill??0;if(e.key==='Home')value=0;else if(e.key==='End')value=100;else value=Math.max(0,Math.min(100,value+((e.key==='ArrowRight'?1:e.key==='PageUp'?10:e.key==='PageDown'?-10:-1))));
    saveHill(card,value);return;
  }
  const cur=e.target.closest('[data-card]');if(!cur)return;
  if(e.shiftKey&&e.key.startsWith('Arrow')){
    e.preventDefault();
    const dir=e.key.slice(5).toLowerCase();if(LAYOUT==='grouped'&&(dir==='left'||dir==='right'))keyboardAxisMove(cur,dir);else keyboardMove(cur,dir);
    return;
  }
  if(e.key==='Enter'||e.key===' '){e.preventDefault();openCard(cur.dataset.card);return}
  const col=cur.closest('.col');if(!col)return;
  const inCol=[...col.querySelectorAll('[data-card]')];
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){
    const next=inCol[inCol.indexOf(cur)+(e.key==='ArrowDown'?1:-1)];
    if(next){next.focus();e.preventDefault()}
    return;
  }
  if(e.key==='ArrowLeft'||e.key==='ArrowRight'){
    const cols=[...cur.closest('.cols').querySelectorAll('.col')];
    let ci=cols.indexOf(col);
    const idx=inCol.indexOf(cur);
    for(ci+=e.key==='ArrowRight'?1:-1;ci>=0&&ci<cols.length;ci+=e.key==='ArrowRight'?1:-1){
      const cards=cols[ci].querySelectorAll('[data-card]');
      if(cards.length){cards[Math.min(idx,cards.length-1)].focus();e.preventDefault();return}
    }
  }
}
// Patch-don't-replace rendering: reconcile the live DOM against fresh HTML so
// a background poll never resets scroll positions or steals focus. Nodes are
// matched by key (data-card / id) or by position+tag, then updated in place.
function nodeKey(n){return n.nodeType===1?(n.dataset&&n.dataset.morphKey?'key:'+n.dataset.morphKey:n.dataset&&n.dataset.card?'card:'+n.dataset.card:n.id?'#'+n.id:null):null}
function morphChildren(live,next){
  const want=[...next.childNodes];
  const byKey=new Map();
  for(const n of live.childNodes){const k=nodeKey(n);if(k)byKey.set(k,n)}
  let i=0;
  for(const nb of want){
    const k=nodeKey(nb);
    let match=k?byKey.get(k):null;
    if(!match&&!k){
      const cand=live.childNodes[i];
      if(cand&&nodeKey(cand)===null&&cand.nodeType===nb.nodeType&&(cand.nodeType!==1||cand.tagName===nb.tagName))match=cand;
    }
    if(match){
      if(live.childNodes[i]!==match)live.insertBefore(match,live.childNodes[i]||null);
      if(match.nodeType===3){if(match.data!==nb.data)match.data=nb.data}
      else if(match.outerHTML!==nb.outerHTML)morphNode(match,nb);
    }else{
      live.insertBefore(nb.cloneNode(true),live.childNodes[i]||null);
    }
    i++;
  }
  while(live.childNodes.length>want.length)live.removeChild(live.lastChild);
}
function morphNode(live,next){
  for(const at of [...next.attributes])if(live.getAttribute(at.name)!==at.value)live.setAttribute(at.name,at.value);
  for(const at of [...live.attributes])if(!next.hasAttribute(at.name))live.removeAttribute(at.name);
  morphChildren(live,next);
}
function patchView(v,html){
  if(!v.firstChild){v.innerHTML=html;return}
  const tmp=document.createElement('div');tmp.innerHTML=html;
  morphChildren(v,tmp);
}
function boardHtml(b){
  const errs=(b.findings||[]).filter(f=>f.severity==='error').length;
  const body=LAYOUT==='table'?tableHtml(b):LAYOUT==='swimlane'?swimlaneHtml(b):LAYOUT==='calendar'?calendarHtml(b)
    :LAYOUT==='timeline'?timelineHtml(b):LAYOUT==='grouped'?groupedHtml(b):LAYOUT==='metrics'?metricsHtml(b):LAYOUT==='hill'?hillHtml(b)
    :colsHtml(b)+wormholesHtml();
  return '<div id="bstats">'+chips(b.distribution)+(errs?'<div class="err">'+errs+' lint error(s)</div>':'')+'</div>'
    +'<div id="bcols" data-layout="'+esc(LAYOUT)+'">'+body+'</div>';
}
async function refreshBoard(quiet){
  const flow=LAYOUT==='metrics'?'1':'0';
  let b;try{b=await api('/api/projects/'+SEL+'/board?flow='+flow)}catch(err){if(!quiet)$('#view').innerHTML='<div class="err">'+esc(err.message)+'</div>';return}
  if(quiet&&JSON.stringify(b)===JSON.stringify(BOARD))return;
  BOARD=b;
  renderBoardButtons();
  const pi=$('#pinfo');if(pi){pi.textContent=b.cards+' cards · '+pct(b.progress);pi.title='structural progress: every card is one unit; a sub-board fills its unit by its own fraction'}
  const v=$('#view');if(!v)return;
  syncSearchControls(b);
  syncViewControls(b);
  patchView(v,boardHtml(b));
  v.onclick=boardClicks;
  v.onkeydown=boardKeys;
  v.onpointerdown=boardPointerDown;
  if(LAYOUT==='kanban')requestAnimationFrame(()=>drawRelations(b));
  if(SEARCH_QUERY.trim()||SEARCH_SAVED)runSearch();
}
function drawRelations(b){
  const cols=$('.cols');if(!cols)return;
  const svg=$('#relation-overlay',cols);if(!svg)return;
  while(svg.firstChild)svg.removeChild(svg.firstChild);
  svg.setAttribute('width',String(cols.scrollWidth));svg.setAttribute('height',String(cols.scrollHeight));
  const nodes=new Map([...cols.querySelectorAll('[data-card]')].map(el=>[el.dataset.card,el]));
  const edges=[],seen=new Set();
  for(const lane of b.lanes||[])for(const card of lane.cards||[])for(const rel of card.relationships||[]){
    if(String(rel.target).includes('#')||!nodes.has(rel.target))continue;
    if(rel.source==='text')continue;
    const symmetric=rel.type==='relates';
    const key=symmetric?[card.id,rel.target].sort().join('|'):card.id+'|'+rel.type+'|'+rel.target;
    if(seen.has(key))continue;seen.add(key);edges.push({from:card.id,to:rel.target,resolved:rel.active===false});
  }
  if(!edges.length)return;
  const ns='http://www.w3.org/2000/svg';
  const defs=document.createElementNS(ns,'defs'),marker=document.createElementNS(ns,'marker');
  marker.setAttribute('id','rel-arrow');marker.setAttribute('viewBox','0 0 10 10');marker.setAttribute('refX','9');marker.setAttribute('refY','5');marker.setAttribute('markerWidth','5');marker.setAttribute('markerHeight','5');marker.setAttribute('orient','auto-start-reverse');
  const arrow=document.createElementNS(ns,'path');arrow.setAttribute('d','M 0 0 L 10 5 L 0 10 z');arrow.setAttribute('fill','var(--st-blocked)');marker.appendChild(arrow);defs.appendChild(marker);svg.appendChild(defs);
  const base=cols.getBoundingClientRect();
  for(const edge of edges){
    const a=nodes.get(edge.from).getBoundingClientRect(),z=nodes.get(edge.to).getBoundingClientRect();
    const left=a.left<z.left,x1=(left?a.right:a.left)-base.left+cols.scrollLeft,x2=(left?z.left:z.right)-base.left+cols.scrollLeft;
    const y1=a.top+a.height/2-base.top+cols.scrollTop,y2=z.top+z.height/2-base.top+cols.scrollTop,curve=Math.max(28,Math.abs(x2-x1)*.42);
    const path=document.createElementNS(ns,'path');path.setAttribute('d','M '+x1+' '+y1+' C '+(x1+(left?curve:-curve))+' '+y1+', '+(x2+(left?-curve:curve))+' '+y2+', '+x2+' '+y2);
    path.setAttribute('marker-end','url(#rel-arrow)');if(edge.resolved)path.classList.add('resolved');svg.appendChild(path);
  }
}
window.addEventListener('resize',()=>{if(BOARD&&VIEW==='board'&&LAYOUT==='kanban')drawRelations(BOARD)});
function hillAt(ev,plot){const r=plot.getBoundingClientRect();return Math.max(0,Math.min(100,Math.round((ev.clientX-r.left-r.width*.04)/(r.width*.92)*100)))}
function paintHillDot(dot,value){dot.style.left=(4+value*.92)+'%';dot.style.top=hillY(value)+'px';dot.setAttribute('aria-valuenow',String(value));dot.setAttribute('aria-label',(dot.getAttribute('aria-label')||'hill position '+value).replace(/hill position \d+$/,'hill position '+value));dot.classList.remove('unset')}
function saveHill(card,value){
  const key=SEL+'\u0000'+card.id,current=HILL_PENDING.get(key);
  if(!current&&card.hill===value)return;
  const state=current||{project:SEL,card:card,value:value,timer:null,running:false};
  state.card=card;state.value=value;HILL_PENDING.set(key,state);
  const dot=[...document.querySelectorAll('[data-hill]')].find(x=>x.dataset.hill===card.id);if(dot)paintHillDot(dot,value);
  if(state.running)return;
  if(state.timer)clearTimeout(state.timer);
  state.timer=setTimeout(()=>flushHill(key),90);
}
async function flushHill(key){
  const state=HILL_PENDING.get(key);if(!state||state.running)return;
  state.timer=null;state.running=true;const value=state.value;
  try{
    await api('/api/projects/'+state.project+'/cards/'+state.card.id+'/edit',{method:'POST',body:JSON.stringify({hill:value})});
    state.card.hill=value;state.running=false;
    if(state.value!==value){state.timer=setTimeout(()=>flushHill(key),90);return}
    HILL_PENDING.delete(key);if(SEL===state.project&&VIEW==='board')await refreshBoard(true);toast(state.card.id+' hill → '+value);
  }catch(err){HILL_PENDING.delete(key);toast(err.message);if(SEL===state.project&&VIEW==='board')refreshBoard(true)}
}
// A press on a card is only a drag once it has proved itself: a mouse has to
// travel past the slop threshold, and a finger has to stay put long enough
// that it clearly is not a scroll. Until then the press is still a click.
function boardPointerDown(e){
  if(RO||e.button!==0)return;
  const hill=e.target.closest('[data-hill]');
  if(hill&&LAYOUT==='hill'){
    const card=visibleCards(BOARD).find(c=>c.id===hill.dataset.hill),plot=hill.closest('[data-hillplot]');if(!card||!plot)return;
    e.preventDefault();try{hill.setPointerCapture(e.pointerId)}catch{}
    const value=hillAt(e,plot);paintHillDot(hill,value);HILL_DRAG={dot:hill,plot:plot,card:card,value:value,pointerId:e.pointerId};return;
  }
  if(LAYOUT!=='kanban'&&LAYOUT!=='grouped')return;
  const card=e.target.closest('[data-card]');
  if(!card||e.target.closest('button,a,input,textarea,select'))return;
  const touch=e.pointerType!=='mouse';
  PRESS={card:card,x:e.clientX,y:e.clientY,pointerId:e.pointerId,touch:touch,timer:null,ev:e};
  if(touch){
    PRESS.timer=setTimeout(()=>{
      if(!PRESS)return;
      const p=PRESS;PRESS=null;
      try{p.card.setPointerCapture(p.pointerId)}catch{}
      dragStart(p.card,p.ev);
    },HOLD_MS);
  }
}
window.addEventListener('pointermove',e=>{
  if(HILL_DRAG){e.preventDefault();HILL_DRAG.value=hillAt(e,HILL_DRAG.plot);paintHillDot(HILL_DRAG.dot,HILL_DRAG.value);return}
  if(PRESS){
    const dx=Math.abs(e.clientX-PRESS.x),dy=Math.abs(e.clientY-PRESS.y);
    if(PRESS.touch){
      // Moving before the hold elapsed means they meant to scroll.
      if(dx>SLOP||dy>SLOP){clearTimeout(PRESS.timer);PRESS=null}
      return;
    }
    if(dx>SLOP||dy>SLOP){
      const p=PRESS;PRESS=null;
      try{p.card.setPointerCapture(p.pointerId)}catch{}
      dragStart(p.card,e);
    }
    return;
  }
  if(DRAG){e.preventDefault();dragMove(e)}
},{passive:false});
window.addEventListener('pointerup',()=>{if(HILL_DRAG){const h=HILL_DRAG;HILL_DRAG=null;saveHill(h.card,h.value)}else if(DRAG)dragDrop();else dragCleanup()});
window.addEventListener('pointercancel',()=>{HILL_DRAG=null;dragCleanup()});
// A drag in flight must survive the background poll: patchView would otherwise
// reconcile the dragged node out from under the pointer.
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&DRAG)dragCleanup()});
/** Transient message for a failure that has no dialog of its own. */
function toast(message){
  const t=document.createElement('div');
  t.className='draghint';t.setAttribute('role','status');t.textContent=message;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(),4000);
}
// ---- the board editor: lanes, canonical mapping, rollup, migrations ----
async function boardEditor(){
  let cfg;try{cfg=await api('/api/projects/'+SEL+'/config')}catch(err){return}
  const counts={};
  if(BOARD)for(const l of BOARD.lanes)counts[l.id]=l.cards.length;
  const CANON=['wishlist','todo','doing','blocked','done','archive'];
  const laneRow=l=>'<div class="lanerow" data-lane>'
    +'<input class="lid" value="'+esc(l.id)+'" placeholder="lane-id" aria-label="lane id">'
    +'<select class="lcan" aria-label="canonical state">'+CANON.map(c=>'<option '+(c===l.canonical?'selected':'')+'>'+c+'</option>').join('')+'</select>'
    +'<input class="lsub" value="'+esc((l.substates||[]).join(', '))+'" placeholder="substates (comma separated)" aria-label="substates">'
    +'<select class="lord" aria-label="substate order"><option '+(l.order!=='strict'?'selected':'')+'>free</option><option '+(l.order==='strict'?'selected':'')+'>strict</option></select>'
    +'<input class="lwip" type="number" min="1" value="'+(l.wip==null?'':l.wip)+'" placeholder="wip" aria-label="wip limit">'
    +'<select class="lwipmode" aria-label="WIP enforcement"><option '+(l.wipMode!=='justify'&&l.wipMode!=='deny'?'selected':'')+'>allow</option><option '+(l.wipMode==='justify'?'selected':'')+'>justify</option><option '+(l.wipMode==='deny'?'selected':'')+'>deny</option></select>'
    +'<button type="button" class="ghost" data-rm aria-label="remove lane">✕</button>'
    +'<span class="mig" hidden>→ move its cards to <select class="mtarget" aria-label="migration target"></select></span>'
    +'</div>';
  const labelRow=l=>'<div class="registryrow" data-labeldef>'
    +'<input class="rid" value="'+esc(l.id||'')+'" placeholder="Group/Value or tag" aria-label="label id">'
    +'<input class="rcolor" value="'+esc(l.color||'')+'" placeholder="#RRGGBB" aria-label="label color">'
    +'<button type="button" class="ghost" data-rmlabel aria-label="remove label">✕</button></div>';
  const TYPES=['text','number','checkbox','date','select','multi-select','url','person'];
  const fieldRow=f=>'<div class="registryrow" data-fielddef>'
    +'<input class="rid" value="'+esc(f.id||'')+'" placeholder="field_id" aria-label="field id">'
    +'<input class="rname" value="'+esc(f.name||'')+'" placeholder="display name" aria-label="field name">'
    +'<select class="rtype" aria-label="field type">'+TYPES.map(t=>'<option '+(t===f.type?'selected':'')+'>'+t+'</option>').join('')+'</select>'
    +'<input class="ropts" value="'+esc((f.options||[]).join(', '))+'" placeholder="select options, comma separated" aria-label="field options">'
    +'<label class="rface"><input type="checkbox" '+(f.face?'checked':'')+'> face</label>'
    +'<button type="button" class="ghost" data-rmfield aria-label="remove field">✕</button></div>';
  const templateRow=t=>'<details class="templaterow" data-template open><summary>'+esc(t.name||t.id||'new template')+'</summary><div class="templategrid">'
    +'<input class="tid" value="'+esc(t.id||'')+'" placeholder="template-id" aria-label="template id">'
    +'<input class="tname" value="'+esc(t.name||'')+'" placeholder="display name" aria-label="template name">'
    +'<input class="tlane" value="'+esc(t.lane||'')+'" placeholder="default lane" aria-label="template lane">'
    +'<input class="tlabels" value="'+esc((t.labels||[]).join(', '))+'" placeholder="labels" aria-label="template labels">'
    +'<input class="tpriority" value="'+esc(t.priority||'')+'" placeholder="priority" aria-label="template priority">'
    +'<input class="testimate" type="number" min="1" value="'+(t.estimate==null?'':t.estimate)+'" placeholder="estimate" aria-label="template estimate">'
    +'<input class="tassignee" value="'+esc(t.assignee||'')+'" placeholder="assignee" aria-label="template assignee">'
    +'<input class="tdelegate" value="'+esc(t.delegate||'')+'" placeholder="delegate" aria-label="template delegate">'
    +'<input class="tstart" value="'+esc(t.start||'')+'" placeholder="start" aria-label="template start">'
    +'<input class="tdue" value="'+esc(t.due||'')+'" placeholder="due" aria-label="template due">'
    +'<input class="tcolor" value="'+esc(t.cover_color||'')+'" placeholder="cover color" aria-label="template cover color">'
    +'<label class="rface"><input class="tevergreen" type="checkbox" '+(t.evergreen?'checked':'')+'> evergreen</label>'
    +'<input class="tfields" value="'+esc(JSON.stringify(t.fields||{}))+'" placeholder="custom fields JSON" aria-label="template custom fields">'
    +'<button type="button" class="ghost" data-rmtemplate aria-label="remove template">✕ remove</button>'
    +'<textarea class="tbody" placeholder="initial markdown body" aria-label="template body">'+esc(t.body||'')+'</textarea></div></details>';
  const blockerRow=b=>'<div class="registryrow" data-blockerdef>'
    +'<input class="rid" value="'+esc(b.id||'')+'" placeholder="blocker-id" aria-label="blocker id">'
    +'<input class="rname" value="'+esc(b.name||'')+'" placeholder="display name" aria-label="blocker name">'
    +'<input class="rcolor" value="'+esc(b.color||'')+'" placeholder="#RRGGBB" aria-label="blocker color">'
    +'<button type="button" class="ghost" data-rmblocker aria-label="remove blocker">✕</button></div>';
  const buttonRow=b=>'<div class="registryrow" data-buttondef>'
    +'<input class="rid" value="'+esc(b.id||'')+'" placeholder="button-id" aria-label="button id">'
    +'<input class="rname" value="'+esc(b.name||'')+'" placeholder="label" aria-label="button label">'
    +'<select class="bscope" aria-label="button scope"><option '+(b.scope!=='board'?'selected':'')+'>card</option><option '+(b.scope==='board'?'selected':'')+'>board</option></select>'
    +'<input class="bfilter" value="'+esc(b.filter||'')+'" placeholder="saved filter (board)" aria-label="button saved filter">'
    +'<select class="baction" aria-label="button action">'+['move','close','label'].map(a=>'<option '+(a===b.action?'selected':'')+'>'+a+'</option>').join('')+'</select>'
    +'<input class="rwide bvalue" value="'+esc(b.value||'')+'" placeholder="lane or label (close is empty)" aria-label="button value">'
    +'<button type="button" class="ghost" data-rmbutton aria-label="remove button">✕</button></div>';
  const ruleRow=r=>'<div class="registryrow" data-ruledef>'
    +'<input class="rid" value="'+esc(r.id||'')+'" placeholder="rule-id" aria-label="rule id">'
    +'<select class="revent" aria-label="rule event">'+['enter','close','block'].map(v=>'<option '+(v===r.event?'selected':'')+'>'+v+'</option>').join('')+'</select>'
    +'<input class="rlane" value="'+esc(r.lane||'')+'" placeholder="lane for enter" aria-label="rule lane">'
    +'<input class="rfilter" value="'+esc(r.filter||'')+'" placeholder="saved filter" aria-label="rule saved filter">'
    +'<select class="raction" aria-label="rule action">'+['label','unlabel','assign','delegate','comment'].map(v=>'<option '+(v===r.action?'selected':'')+'>'+v+'</option>').join('')+'</select>'
    +'<input class="rwide rvalue" value="'+esc(r.value||'')+'" placeholder="action value" aria-label="rule value">'
    +'<button type="button" class="ghost" data-rmrule aria-label="remove rule">✕</button></div>';
  const m=overlay('<h3>Edit board</h3>'
    +'<div class="field"><label>board name<input id="bname" value="'+esc(cfg.name)+'"></label></div>'
    +'<h4>lanes</h4><p class="setting-note">Every lane projects onto one canonical state; lanes named after a canonical state map to themselves. Removing a lane migrates its cards, and each move is logged on the card.</p>'
    +'<div id="lanes">'+cfg.lanes.map(laneRow).join('')+'</div>'
    +'<button type="button" id="addlane">+ lane</button>'
    +'<h4>labels</h4><p class="setting-note">Use Group/Value for a single-select group. Colors are optional and undeclared labels still work.</p>'
    +'<div id="labeldefs">'+(cfg.labels||[]).map(labelRow).join('')+'</div><button type="button" id="addlabel">+ label</button>'
    +'<h4>custom fields</h4><p class="setting-note">Values remain ordinary card frontmatter. Face fields appear on compact cards only when filled.</p>'
    +'<div id="fielddefs">'+(cfg.fields||[]).map(fieldRow).join('')+'</div><button type="button" id="addfield">+ field</button>'
    +'<h4>card templates</h4><p class="setting-note">Templates copy defaults into a new ordinary card. Use {{title}} in the initial markdown body.</p>'
    +'<div id="templatedefs">'+(cfg.templates||[]).map(templateRow).join('')+'</div><button type="button" id="addtemplate">+ template</button>'
    +'<h4>named blockers</h4><p class="setting-note">Reusable blocker reasons make blocked time comparable. A card with a named blocker cannot be dragged until it is unblocked.</p>'
    +'<div id="blockerdefs">'+(cfg.blockers||[]).map(blockerRow).join('')+'</div><button type="button" id="addblocker">+ blocker</button>'
    +'<h4>one-click buttons</h4><p class="setting-note">Card buttons affect one open card. Board buttons affect at most 100 cards selected by a saved filter.</p>'
    +'<div id="buttondefs">'+(cfg.buttons||[]).map(buttonRow).join('')+'</div><button type="button" id="addbutton">+ button</button>'
    +'<h4>event rules</h4><p class="setting-note">Rules run locally after enter, close, or block events. They cannot move cards, call the network, or recursively trigger rules.</p>'
    +'<div id="ruledefs">'+(cfg.rules||[]).map(ruleRow).join('')+'</div><button type="button" id="addrule">+ rule</button>'
    +'<h4>scheduled automation</h4><div class="field"><label>archive done cards after this many days (empty disables)<input id="archiveafter" type="number" min="1" value="'+esc(cfg.automation&&cfg.automation.archiveDoneAfter||'')+'"></label></div>'
    +'<h4>rollup policy</h4><div class="rollups">'
    +'<label>blocked when<select id="rbw"><option '+(cfg.rollup.blockedWhen==='any-blocked'?'selected':'')+'>any-blocked</option><option '+(cfg.rollup.blockedWhen==='never'?'selected':'')+'>never</option></select></label>'
    +'<label>doing when<select id="rdw"><option '+(cfg.rollup.doingWhen==='any-started'?'selected':'')+'>any-started</option><option '+(cfg.rollup.doingWhen==='any-doing'?'selected':'')+'>any-doing</option></select></label>'
    +'<label>else<select id="rel"><option '+(cfg.rollup.elseState==='todo'?'selected':'')+'>todo</option><option '+(cfg.rollup.elseState==='wishlist'?'selected':'')+'>wishlist</option></select></label>'
    +'</div>'
    +'<div class="err" role="alert"></div>'
    +'<div class="actions"><button type="button" class="ghost" data-x>cancel</button><button type="button" class="primary" id="bsave">save board</button></div>','editor','Edit board');
  const originalIds=cfg.lanes.map(l=>l.id);
  const refreshMigTargets=()=>{
    const liveIds=[...m.querySelectorAll('[data-lane]:not(.dead) .lid')].map(i=>i.value.trim()).filter(Boolean);
    for(const row of m.querySelectorAll('[data-lane].dead')){
      const sel=row.querySelector('.mtarget');
      const cur=sel.value;
      sel.innerHTML=liveIds.map(i=>'<option '+(i===cur?'selected':'')+'>'+esc(i)+'</option>').join('');
    }
  };
  $('#addlane',m).onclick=()=>{$('#lanes',m).insertAdjacentHTML('beforeend',laneRow({id:'',canonical:'todo',substates:[],order:'free',wip:null,wipMode:'allow'}));$('#lanes',m).lastElementChild.querySelector('.lid').focus()};
  $('#addlabel',m).onclick=()=>{$('#labeldefs',m).insertAdjacentHTML('beforeend',labelRow({id:'',color:''}));$('#labeldefs',m).lastElementChild.querySelector('.rid').focus()};
  $('#addfield',m).onclick=()=>{$('#fielddefs',m).insertAdjacentHTML('beforeend',fieldRow({id:'',name:'',type:'text',options:[],face:false}));$('#fielddefs',m).lastElementChild.querySelector('.rid').focus()};
  $('#addtemplate',m).onclick=()=>{$('#templatedefs',m).insertAdjacentHTML('beforeend',templateRow({id:'',name:'',labels:[],fields:{},body:''}));$('#templatedefs',m).lastElementChild.querySelector('.tid').focus()};
  $('#addblocker',m).onclick=()=>{$('#blockerdefs',m).insertAdjacentHTML('beforeend',blockerRow({id:'',name:'',color:''}));$('#blockerdefs',m).lastElementChild.querySelector('.rid').focus()};
  $('#addbutton',m).onclick=()=>{$('#buttondefs',m).insertAdjacentHTML('beforeend',buttonRow({id:'',name:'',scope:'card',action:'move',value:''}));$('#buttondefs',m).lastElementChild.querySelector('.rid').focus()};
  $('#addrule',m).onclick=()=>{$('#ruledefs',m).insertAdjacentHTML('beforeend',ruleRow({id:'',event:'enter',action:'label',value:''}));$('#ruledefs',m).lastElementChild.querySelector('.rid').focus()};
  $('#labeldefs',m).onclick=e=>{const x=e.target.closest('[data-rmlabel]');if(x)x.closest('[data-labeldef]').remove()};
  $('#fielddefs',m).onclick=e=>{const x=e.target.closest('[data-rmfield]');if(x)x.closest('[data-fielddef]').remove()};
  $('#templatedefs',m).onclick=e=>{const x=e.target.closest('[data-rmtemplate]');if(x)x.closest('[data-template]').remove()};
  $('#blockerdefs',m).onclick=e=>{const x=e.target.closest('[data-rmblocker]');if(x)x.closest('[data-blockerdef]').remove()};
  $('#buttondefs',m).onclick=e=>{const x=e.target.closest('[data-rmbutton]');if(x)x.closest('[data-buttondef]').remove()};
  $('#ruledefs',m).onclick=e=>{const x=e.target.closest('[data-rmrule]');if(x)x.closest('[data-ruledef]').remove()};
  $('#lanes',m).oninput=refreshMigTargets;
  $('#lanes',m).onclick=e=>{
    const rm=e.target.closest('[data-rm]');if(!rm)return;
    const row=rm.closest('[data-lane]');
    const id=row.querySelector('.lid').value.trim();
    if(row.classList.contains('dead')){row.classList.remove('dead');row.querySelector('.mig').hidden=true;refreshMigTargets();return}
    if(!originalIds.includes(id)){row.remove();refreshMigTargets();return}
    row.classList.add('dead');
    if((counts[id]||0)>0)row.querySelector('.mig').hidden=false;
    refreshMigTargets();
  };
  $('#bsave',m).onclick=async()=>{
    const lanes=[],labels=[],fields=[],templates=[],blockers=[],buttons=[],rules=[],migrations={};
    for(const row of m.querySelectorAll('[data-lane]')){
      const id=row.querySelector('.lid').value.trim();
      if(row.classList.contains('dead')){
        const t=row.querySelector('.mtarget').value;
        if(!row.querySelector('.mig').hidden&&t)migrations[id]=t;
        continue;
      }
      if(id==='')continue;
      const wip=row.querySelector('.lwip').value.trim();
      lanes.push({id,canonical:row.querySelector('.lcan').value,
        substates:row.querySelector('.lsub').value.split(',').map(s=>s.trim()).filter(Boolean),
        order:row.querySelector('.lord').value,wip:wip===''?null:Number(wip),wipMode:row.querySelector('.lwipmode').value});
    }
    for(const row of m.querySelectorAll('[data-labeldef]')){
      const id=row.querySelector('.rid').value.trim();if(!id)continue;
      labels.push({id,color:row.querySelector('.rcolor').value.trim()||undefined});
    }
    for(const row of m.querySelectorAll('[data-fielddef]')){
      const id=row.querySelector('.rid').value.trim();if(!id)continue;
      const type=row.querySelector('.rtype').value;
      const options=row.querySelector('.ropts').value.split(',').map(s=>s.trim()).filter(Boolean);
      fields.push({id,name:row.querySelector('.rname').value.trim()||id,type,
        options:type==='select'||type==='multi-select'?options:undefined,face:row.querySelector('.rface input').checked});
    }
    for(const row of m.querySelectorAll('[data-template]')){
      const id=row.querySelector('.tid').value.trim();if(!id)continue;
      let templateFields={};
      try{templateFields=JSON.parse(row.querySelector('.tfields').value||'{}')}
      catch{$('.err',m).textContent='template '+id+': custom fields must be valid JSON';return}
      const estimate=row.querySelector('.testimate').value;
      templates.push({id,name:row.querySelector('.tname').value.trim()||id,lane:row.querySelector('.tlane').value.trim()||undefined,
        labels:row.querySelector('.tlabels').value.split(',').map(s=>s.trim()).filter(Boolean),priority:row.querySelector('.tpriority').value.trim()||undefined,
        assignee:row.querySelector('.tassignee').value.trim()||undefined,delegate:row.querySelector('.tdelegate').value.trim()||undefined,
        start:row.querySelector('.tstart').value.trim()||undefined,due:row.querySelector('.tdue').value.trim()||undefined,
        estimate:estimate?Number(estimate):undefined,evergreen:row.querySelector('.tevergreen').checked,
        cover_color:row.querySelector('.tcolor').value.trim()||undefined,fields:templateFields,body:row.querySelector('.tbody').value});
    }
    for(const row of m.querySelectorAll('[data-blockerdef]')){
      const id=row.querySelector('.rid').value.trim();if(!id)continue;
      blockers.push({id,name:row.querySelector('.rname').value.trim()||id,color:row.querySelector('.rcolor').value.trim()||undefined});
    }
    for(const row of m.querySelectorAll('[data-buttondef]')){
      const id=row.querySelector('.rid').value.trim();if(!id)continue;
      const action=row.querySelector('.baction').value;
      buttons.push({id,name:row.querySelector('.rname').value.trim()||id,scope:row.querySelector('.bscope').value,
        filter:row.querySelector('.bfilter').value.trim()||undefined,action,value:action==='close'?undefined:row.querySelector('.bvalue').value.trim()||undefined});
    }
    for(const row of m.querySelectorAll('[data-ruledef]')){
      const id=row.querySelector('.rid').value.trim();if(!id)continue;
      const event=row.querySelector('.revent').value;
      rules.push({id,event,lane:event==='enter'?row.querySelector('.rlane').value.trim()||undefined:undefined,
        filter:row.querySelector('.rfilter').value.trim()||undefined,action:row.querySelector('.raction').value,value:row.querySelector('.rvalue').value.trim()});
    }
    const archiveAfter=$('#archiveafter',m).value.trim();
    try{
      await api('/api/projects/'+SEL+'/config',{method:'PUT',body:JSON.stringify({
        name:$('#bname',m).value,lanes,labels,fields,templates,blockers,buttons,rules,
        automation:{archiveDoneAfter:archiveAfter===''?null:Number(archiveAfter)},
        rollup:{blockedWhen:$('#rbw',m).value,doingWhen:$('#rdw',m).value,elseState:$('#rel',m).value},migrations})});
      closeOverlay();BOARD=null;refreshBoard();reloadOrg();
    }catch(err){$('.err',m).textContent=err.message}
  };
  m.querySelector('[data-x]').onclick=closeOverlay;
  refreshMigTargets();
}
// ---- public (shared link) mode: read-only, no org chrome ----
function publicDead(message){
  document.body.innerHTML='<div class="gate"><h2>'+esc(message)+'</h2>'
    +'<div class="gatefoot">Git-native kanban for AI agents. <a href="/about">learn more</a> · <a href="https://github.com/kodareef5/botflow" target="_blank" rel="noopener">GitHub</a></div></div>';
}
async function publicStart(){
  try{applyTheme(await api('/api/theme'))}catch{}
  if(PUBCARD)return publicCardStart();
  let b;
  try{b=await api('/api/public/'+PUB+'/board?flow='+(LAYOUT==='metrics'?'1':'0'))}catch(err){return publicDead(err.message)}
  renderPublic(b);
  setInterval(async()=>{
    if(MODAL)return;
    try{const nb=await api('/api/public/'+PUB+'/board?flow='+(LAYOUT==='metrics'?'1':'0'));if(JSON.stringify(nb)!==JSON.stringify(BOARD))renderPublic(nb)}catch{}
  },4000);
}
// A card-scoped link renders that one card as the whole page: same card
// anatomy as the modal, standing alone, read only, live.
let PUBTAB='card',PUBLAST='';
async function publicCardStart(){
  let c;
  try{c=await api(cardReadApi(PUBCARD))}catch(err){return publicDead(err.message)}
  document.body.classList.add('pubcard');
  document.body.innerHTML='<header class="top"><h1 id="pctitle"></h1><span class="spacer"></span></header>'
    +'<div class="view" style="flex:1;overflow:auto"><div class="modal cardmodal" style="margin:0 auto" id="pcbox"></div></div>'
    +'<div class="pubfoot">a single card shared with botflow: git-native kanban for AI agents. <a href="/about">learn more</a></div>';
  renderPublicCard(c);
  setInterval(async()=>{
    try{const nc=await api(cardReadApi(PUBCARD));
      const next=JSON.stringify(nc);
      if(next!==PUBLAST)renderPublicCard(nc)}catch{}
  },4000);
}
function renderPublicCard(c){
  PUBLAST=JSON.stringify(c);
  document.title=c.title+' · botflow';
  $('#pctitle').innerHTML=esc(c.id)+' <span class="sub">shared card · read only</span>';
  const box=$('#pcbox');
  box.innerHTML=cardModalHtml(c,PUBTAB);
  wireTablist(box.querySelector('.tabbar'),'data-ctab',b=>{PUBTAB=b.dataset.ctab;renderPublicCard(c)});
  if(PUBTAB==='chat'||PUBTAB==='activity')loadCardHistory(box,c,PUBTAB==='chat'?'comments':'activity');
}
function renderPublic(b){
  const fresh=!BOARD;
  BOARD=b;
  document.title=b.name+' · botflow';
  if(fresh){
    document.body.innerHTML='<header class="top"><h1>'+esc(b.name)+' <span class="sub">shared board · read only</span></h1>'
      +'<div class="meter" id="hmeter" title="structural progress: every card is one unit; a sub-board fills its unit by its own fraction"></div><span id="hstrip"></span><span class="spacer"></span>'
      +'<div class="viewctl"><select id="boardlayout" aria-label="board view">'+[['kanban','board'],['table','table'],['swimlane','swimlanes'],['calendar','calendar'],['timeline','timeline'],['grouped','group by field'],['metrics','metrics'],['hill','hill chart']].map(x=>'<option value="'+x[0]+'"'+(LAYOUT===x[0]?' selected':'')+'>'+x[1]+'</option>').join('')+'</select><select id="axisctl" class="axisctl" aria-label="grouping axis" hidden></select></div></header>'
      +'<div class="view" id="view" style="flex:1;overflow:auto"></div>'
      +'<div class="pubfoot">shared with botflow: git-native kanban for AI agents. <a href="/about">learn more</a></div>';
    $('#view').onclick=boardClicks;
    $('#view').onkeydown=boardKeys;
    $('#boardlayout').onchange=e=>{LAYOUT=e.target.value;localStorage.setItem('bf_layout',LAYOUT);syncViewControls(BOARD);if(LAYOUT==='metrics'&&!BOARD.flow)api('/api/public/'+PUB+'/board?flow=1').then(renderPublic).catch(err=>toast(err.message));else paintBoard()};
    $('#axisctl').onchange=e=>{if(LAYOUT==='grouped'){GROUP_AXIS=e.target.value;localStorage.setItem('bf_group_axis',GROUP_AXIS)}else{SWIM_AXIS=e.target.value;localStorage.setItem('bf_swim_axis',SWIM_AXIS)}paintBoard()};
  }
  $('#hmeter').innerHTML='<div class="track"><div class="fill" style="width:'+Math.round((b.progress||0)*100)+'%"></div></div><b>'+pct(b.progress)+'</b>';
  $('#hstrip').innerHTML=strip(b.distribution);
  syncViewControls(b);
  patchView($('#view'),boardHtml(b));
}
// ---- the card modal ----
async function openCard(cid,tab){
  let c;try{c=await api(cardReadApi(cid))}catch(err){return}
  MODAL=cid;
  const t=tab||'card';
  const m=overlay(cardModalHtml(c,t),'cardmodal',c.id+' '+c.title);
  wireCardModal(m,c,t);
  if(t==='chat'||t==='activity')loadCardHistory(m,c,t==='chat'?'comments':'activity');
}
function cardModalHtml(c,tab){
  const p=c.parsed||{};
  const meta=[statechip(c.state),'<span class="cid">'+esc(c.position)+'</span>'];
  if(c.assignee)meta.push('<span class="badges"><span title="assignee">@'+esc(who(c.assignee))+'</span></span>');
  if(c.delegate)meta.push('<span class="badges"><span title="executing delegate">⇢ @'+esc(who(c.delegate))+'</span></span>');
  if(c.author)meta.push('<span class="badges"><span class="by" title="created by '+esc(c.author)+'">'+esc(who(c.author))+'</span></span>');
  if(c.priority)meta.push('<span class="badges"><span class="'+(c.priority==='p0'?'p0':'')+'">'+esc(c.priority)+'</span></span>');
  for(const l of c.labelDetails||[])meta.push('<span class="badges">'+labelBadge(l)+'</span>');
  if(!(c.labelDetails||[]).length)for(const l of c.labels||[])meta.push('<span class="badges"><span>#'+esc(l)+'</span></span>');
  const due=dueFace(c);if(due)meta.push('<span class="badges">'+due+'</span>');
  if(c.blocked){const bd=blockerOf(c);meta.push('<span class="badges"><span class="'+(c.blocker?'namedblk':'blk')+'"'+(c.blocker?' style="--blocker-color:'+esc(bd.color||'var(--st-blocked)')+'"':'')+'>⛔ '+esc(c.blocker?bd.name:c.blocked)+'</span></span>')}
  if(c.snooze)meta.push('<span class="badges"><span class="snoozed" title="until '+esc(c.snooze)+'">☾ snoozed</span></span>');
  if(!RO){
    const mine=ME&&(ME.kind==='bot'?c.delegate:c.assignee)===ME.username;
    const settled=c.state==='done'||c.state==='archive';
    const watching=!!ME&&(c.watchers||[]).includes(ME.username);
    const voted=!!ME&&(c.votes||[]).includes(ME.username);
    const acts=[];
    if(!settled&&!(mine&&c.state==='doing'))acts.push('<button class="ghost" data-claim title="take this card and move it into doing">▶ claim</button>');
    if(!settled)acts.push('<button class="ghost" data-close title="close this card">✓ close</button>');
    acts.push(c.blocked
      ?'<button class="ghost" data-unblock title="clear the blocked flag">unblock</button>'
      :'<button class="ghost" data-block title="park this card with a reason">⛔ block</button>');
    acts.push(c.snooze
      ?'<button class="ghost" data-wake title="wake this card now">☀ wake</button>'
      :'<button class="ghost" data-snooze title="hide this card from ready work until a time or new activity">☾ snooze</button>');
    acts.push('<button class="ghost" data-watch data-on="'+watching+'" aria-pressed="'+watching+'" title="'+(watching?'stop watching':'watch this card')+'">'+(watching?'◉ watching':'○ watch')+'</button>');
    acts.push('<button class="ghost" data-vote data-on="'+voted+'" aria-pressed="'+voted+'" title="'+(voted?'withdraw your vote':'vote for this card')+'">▲ '+(voted?'voted':'vote')+'</button>');
    acts.push('<button class="ghost" data-boost title="leave a short boost">✦ boost</button>');
    for(const b of ((BOARD&&BOARD.buttons)||[]).filter(b=>b.scope==='card'))acts.push('<button class="ghost" data-cardbutton="'+esc(b.id)+'" title="'+esc(b.action+(b.value?' '+b.value:''))+'">'+esc(b.name)+'</button>');
    meta.push(acts.join(''));
    meta.push('<button class="ghost" data-editcard title="edit card fields">✎ edit</button>'
      +'<button class="ghost" data-mergecard title="merge this duplicate into another card">merge duplicate</button>'
      +'<button class="ghost" data-transfercard title="copy or move this card to a nested board">⇢ handoff</button>'
      +'<button class="ghost" data-feedcard title="create a private activity feed for this card">☊ feed</button>'
      +'<button class="ghost" data-sharecard title="public read-only link to just this card">↗ share</button>');
  }
  const tabs=[['card','card'],['chat','chat '+(c.comments||'')],['activity','activity']];
  return (c.coverColor?'<div class="coverband" style="--cover-color:'+esc(c.coverColor)+'"></div>':'')
    +((cov=>cov?'<img class="banner" src="'+esc(cov)+'" alt="" referrerpolicy="no-referrer">':'')(coverOf(c)))
    +'<div class="inner"><button class="close ghost" data-x aria-label="close card">✕</button>'
    +'<div class="cid">'+esc(c.id)+'</div><h2>'+esc(c.title)+'</h2>'
    +'<div class="metaline">'+meta.join(' ')+'</div>'
    +'<div class="tabbar" role="tablist">'+tabs.map(([id,lbl])=>'<button data-ctab="'+id+'" role="tab" aria-selected="'+(id===tab)+'" class="'+(id===tab?'on':'')+'">'+lbl+'</button>').join('')+'</div>'
    +'<div class="pane" role="tabpanel">'+(tab==='card'?paneCard(c):tab==='chat'?paneChat(c):paneActivity(c))+'</div></div>';
}
function paneCard(c){
  const p=c.parsed||{};
  let out='';
  if(c.type==='board'){
    out+='<h4>project board</h4><div class="subboard" style="max-width:340px"><button data-goto2="'+esc(c.child??'')+'" '+(c.child==null||RO?'disabled':'')+'>'+IC.open+' open board</button>'+statechip(c.state)+'</div>';
  }
  out+='<h4>description'+(RO?'':' <span class="h-act"><button data-desc>'+(p.description?'edit':'write')+'</button></span>')+'</h4>'
    +'<div class="desc">'+(p.description?md(p.description):'<span class="empty">no description</span>')+'</div>';
  const people=(list,empty)=>(list||[]).length?(list||[]).map(u=>'@'+esc(who(u))).join(', '):empty;
  out+='<h4>collaboration</h4><div class="kv">'
    +'<span><b>watching</b> '+people(c.watchers,'nobody')+'</span>'
    +'<span><b>votes</b> '+people(c.votes,'none')+'</span>'
    +'<span><b>mentioned</b> '+people(c.mentions,'nobody')+'</span></div>';
  const boosts=p.boosts||[];
  if(boosts.length)out+='<div class="chat" aria-label="boosts">'+boosts.map(b=>'<div class="msg"><div class="who"><b>'+esc(who(b.actor))+'</b> · '+esc(b.when)+'</div>✦ '+esc(b.text)+'</div>').join('')+'</div>';
  if((p.checklists||[]).length===0&&!RO){
    out+='<h4>checklist <span class="h-act"><button data-additem="Checklist">+ task</button></span></h4><div class="empty">no tasks yet</div>';
  }
  for(const cl of p.checklists||[]){
    const done=cl.items.filter(i=>i.checked).length;
    out+='<div class="cl"><h4>'+esc(cl.section)+(RO?'':' <span class="h-act"><button data-additem="'+esc(cl.section)+'">+ task</button></span>')+'</h4><div class="clhead"><span>'+done+'/'+cl.items.length+'</span><div class="clbar"><i style="width:'+Math.round(done/cl.items.length*100)+'%"></i></div></div>'
      +cl.items.map(i=>'<div class="item '+(i.checked?'done':'')+'" '+(RO?'':'data-check="'+i.index+'" data-on="'+i.checked+'" role="checkbox" aria-checked="'+i.checked+'" tabindex="0"')+' style="'+(RO?'cursor:default':'')+'"><span class="box">'+(i.checked?IC.tick:'')+'</span><span class="txt">'+esc(i.text)+'</span>'+(!RO&&!i.checked?'<button class="ghost promote" data-promote="'+i.index+'" title="promote this task into its own card">promote</button>':'')+'</div>').join('')
      +'</div>';
  }
  const relationships=c.relationships||[];
  out+='<h4>relationships'+(RO?'':' <span class="h-act"><button data-linkcard>+ link</button></span>')+'</h4>';
  out+=relationships.length?'<div class="relations">'+relationships.map(r=>'<div class="relation">'
    +'<span class="rtype">'+esc(r.type)+'</span><button class="ghost" data-opencard="'+esc(r.target)+'">'+esc(r.target)+'</button>'
    +'<span class="rsrc">'+esc(r.source||'stored')+(r.active===false?' · resolved':'')+'</span>'
    +(!RO&&r.source==='stored'?'<button class="ghost" data-unlinkcard="'+esc(r.target)+'" data-reltype="'+esc(r.type)+'" title="remove relation">✕</button>':'')
    +'</div>').join('')+'</div>':'<div class="empty">no linked cards</div>';
  const atts=p.attachments||[];
  out+='<h4>attachments'+(RO?'':' <span class="h-act">'+(UPLOADS?'<button data-upload>+ upload</button>':'')+'<button data-attach>+ add link</button></span>')+'</h4>';
  out+=atts.length?atts.map(a=>{
    let host='';try{host=new URL(a.url).hostname}catch{}
    return '<div class="att">'+IC.clip+'<span class="lbl">'+esc(a.label)+'</span><span class="host">'+esc(host)+'</span>'
      +(linkOk(a.url)?'<a href="'+esc(a.url)+'" target="_blank" rel="noopener">open '+IC.open+'</a>':'<span class="host" style="margin-left:auto">'+esc(a.url)+'</span>')
      +(RO?'':'<button class="ghost" data-detach="'+a.index+'" title="remove">✕</button>')+'</div>';
  }).join(''):'<div class="empty">nothing attached</div>';
  // Image attachments, plus any link whose page advertised a picture. A
  // preview tile opens the page it came from, not the picture: the point of
  // the thumbnail is to stand for the link.
  const tiles=(p.images||[]).map(u=>({img:u,href:u,kind:'image'}))
    .concat((c.previews||[]).map(v=>({img:v.image,href:v.url,kind:'link'}))).filter(t=>imageOk(t.img));
  if(tiles.length){
    out+='<h4>gallery'+(RO?'':' <span class="h-act">'+(c.cover?'<button data-cover="none">hide art</button>':'<button data-cover="auto">auto art</button>')+'</span>')+'</h4><div class="gallery">'
      +tiles.map(t=>'<div class="shot">'
        +(linkOk(t.href)?'<a href="'+esc(t.href)+'" target="_blank" rel="noopener"><img src="'+esc(t.img)+'" alt="" loading="lazy" referrerpolicy="no-referrer"></a>':'<img src="'+esc(t.img)+'" alt="" loading="lazy" referrerpolicy="no-referrer">')
        +(t.kind==='link'?'<span class="src" title="'+esc(t.href)+'">'+esc(hostOf(t.href))+'</span>':'')
        +(RO?'':'<button class="setcov primary" data-cover="'+esc(t.img)+'">☆ cover</button>')+'</div>').join('')+'</div>';
  }
  const kv=[];
  if(c.assignee)kv.push('<span><b>assignee</b> '+esc(who(c.assignee))+'</span>');
  if(c.delegate)kv.push('<span><b>delegate</b> '+esc(who(c.delegate))+'</span>');
  if(c.start)kv.push('<span><b>start</b> '+esc(c.start)+'</span>');
  if(c.due)kv.push('<span><b>due</b> '+esc(c.due)+'</span>');
  if((c.reminders||[]).length)kv.push('<span><b>reminders</b> '+c.reminders.map(m=>esc(m+'m before due')).join(', ')+'</span>');
  if(c.repeat)kv.push('<span><b>repeat</b> every '+esc(c.repeat.every)+' '+esc(c.repeat.unit)+(c.repeat.every===1?'':'s')+' from '+esc(c.repeat.from)+'</span>');
  if(c.snooze)kv.push('<span><b>snoozed until</b> '+esc(c.snooze)+' · new activity wakes it</span>');
  if(c.blocker){const bd=blockerOf(c);kv.push('<span><b>blocker</b> '+esc(bd.name)+' <code>'+esc(c.blocker)+'</code></span>')}
  if(c.estimate!=null)kv.push('<span><b>estimate</b> '+esc(c.estimate)+'</span>');
  if(c.hill!=null)kv.push('<span><b>hill</b> '+esc(c.hill)+' · '+(c.hill<50?'uphill discovery':c.hill===50?'uncertainty crest':'downhill execution')+'</span>');
  if(c.evergreen)kv.push('<span><b>aging</b> evergreen</span>');
  for(const f of c.fields||[])kv.push('<span><b>'+esc(f.name)+'</b> '+esc(fieldText(f.value))+'</span>');
  if(c.created)kv.push('<span><b>created</b> '+esc(c.created)+'</span>');
  if(c.updated)kv.push('<span><b>updated</b> '+esc(c.updated)+'</span>');
  if((c.deps||[]).length)kv.push('<span><b>deps</b> '+c.deps.map(esc).join(', ')+'</span>');
  const fm=c.metrics||{};
  if(fm.currentLaneDays!=null)kv.push('<span><b>current lane</b> '+fm.currentLaneDays+'d</span>');
  if(fm.cumulativeLaneDays!=null)kv.push('<span><b>cumulative lane</b> '+fm.cumulativeLaneDays+'d</span>');
  if(fm.idleDays!=null)kv.push('<span><b>idle</b> '+fm.idleDays+'d</span>');
  if(fm.cycleDays!=null)kv.push('<span><b>cycle</b> '+fm.cycleDays+'d</span>');
  if(fm.leadDays!=null)kv.push('<span><b>lead</b> '+fm.leadDays+'d</span>');
  if(fm.blockedDays)kv.push('<span><b>blocked</b> '+fm.blockedDays+'d</span>');
  if(fm.blockerDays)for(const [id,days] of Object.entries(fm.blockerDays))kv.push('<span><b>blocked · '+esc(id)+'</b> '+esc(days)+'d</span>');
  kv.push('<span><b>file</b> '+esc(c.file)+'</span>');
  out+='<div class="kv">'+kv.join('')+'</div>';
  return out;
}
function paneChat(c){
  return '<div data-cardhistory="comments">loading…</div>'
    +(RO?'':'<form class="composer"><input placeholder="write a comment…" required><button class="primary">send</button></form>');
}
function paneActivity(c){
  return '<div data-cardhistory="activity">loading…</div>';
}
const CARD_HISTORY_PAGE_SIZE=25;
function loadCardHistory(m,c,kind){
  const host=m.querySelector('[data-cardhistory="'+kind+'"]'),pages=[];
  if(!host)return;
  let pageIndex=-1,loading=false,failure='';
  const current=()=>host.isConnected;
  const paint=()=>{
    if(!current())return;
    const page=pages[pageIndex];
    if(!page){host.innerHTML=loading?'loading…':failure?'<div class="err">'+esc(failure)+'</div>':'<div class="empty">'+(kind==='comments'?'no comments yet'+(RO?'':'. talk to your agents here'):'no activity')+'</div>';return}
    const entries=kind==='comments'
      ?'<div class="chat">'+(page.items.length?page.items.map(e=>'<div class="msg"><div class="who"><b>'+esc(e.actor)+'</b> · '+esc(e.when)+'</div>'+esc(e.text)+'</div>').join(''):'<div class="empty">no comments yet'+(RO?'':'. talk to your agents here')+'</div>')+'</div>'
      :'<div class="actlist">'+(page.items.length?page.items.map(e=>'<div class="a"><span class="when">'+esc(e.when)+'</span><span><span class="who">'+esc(e.actor)+'</span> '+esc(e.text)+'</span></div>').join(''):'<div class="empty">no activity</div>')+'</div>';
    const hasNewer=pageIndex>0,hasOlder=pageIndex+1<pages.length||page.next!=null;
    const pager=hasNewer||hasOlder?'<nav aria-label="Card '+(kind==='comments'?'comment':'activity')+' pages" style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px">'
      +'<button type="button" data-cardhistory-prev'+(hasNewer&&!loading?'':' disabled')+'>← newer</button>'
      +'<span class="setting-note" style="margin:0">page '+(pageIndex+1)+' · '+CARD_HISTORY_PAGE_SIZE+' per page</span>'
      +'<button type="button" data-cardhistory-next'+(hasOlder&&!loading?'':' disabled')+'>'+(loading?'loading…':'older →')+'</button></nav>':'';
    host.innerHTML=entries+pager+(failure?'<div class="err">'+esc(failure)+'</div>':'');
    const previous=host.querySelector('[data-cardhistory-prev]');
    if(previous)previous.onclick=()=>{pageIndex--;failure='';paint()};
    const next=host.querySelector('[data-cardhistory-next]');
    if(next)next.onclick=()=>{
      if(pageIndex+1<pages.length){pageIndex++;failure='';paint();return}
      if(page.next!=null)load(page.next);
    };
  };
  const load=async before=>{
    if(loading)return;loading=true;failure='';paint();
    try{
      const cursor=before==null?'':'&before='+encodeURIComponent(before);
      const page=await api(cardHistoryApi(c.id,kind)+'?limit='+CARD_HISTORY_PAGE_SIZE+cursor);
      if(!current())return;
      if(!page||!Array.isArray(page.items))throw new Error('Invalid card history response.');
      pages.splice(pageIndex+1);pages.push(page);pageIndex++;
    }catch(err){failure=err.message}
    finally{loading=false;paint()}
  };
  load(null);
}
function maybeWipPrompt(card,canonical,verb,run){
  const lane=(BOARD&&BOARD.lanes||[]).find(l=>l.canonical===canonical);
  const overflow=!!lane&&card.lane!==lane.id&&lane.wip!=null&&lane.cards.length>=lane.wip;
  if(!overflow||lane.wipMode==='allow')return false;
  const denied=lane.wipMode==='deny';
  if(denied&&!IS_OWNER){toast(lane.name+' denies WIP overflow ('+(lane.cards.length+1)+'/'+lane.wip+').');return true}
  formModal(denied?'Override WIP limit':verb+' with WIP overflow',[
    {name:'reason',label:denied?'owner override justification':'written WIP justification',required:true},
  ],denied?'override and '+verb.toLowerCase():verb.toLowerCase(),d=>run({wipReason:d.reason,...(denied?{force:true}:{})}));
  return true;
}
function checklistKeyTarget(target){
  if(target.closest('button,a,input,textarea,select'))return null;
  return target.closest('[data-check]');
}
function wireCardModal(m,c,tab){
  $('[data-x]',m).onclick=()=>{closeOverlay();if(!PUB)refreshBoard(true)};
  wireTablist(m.querySelector('.tabbar'),'data-ctab',b=>openCard(c.id,b.dataset.ctab));
  m.addEventListener('click',async e=>{
    if(RO)return;
    const go=e.target.closest('[data-goto2]');
    if(go&&!go.disabled){closeOverlay();SEL=go.dataset.goto2;VIEW='board';BOARD=null;renderSide();renderMain();return}
    const open=e.target.closest('[data-opencard]');
    if(open){const target=open.dataset.opencard;if(!target.includes('#'))openCard(target,'card');return}
    const cardButton=e.target.closest('[data-cardbutton]');
    if(cardButton){try{await invokeButton(cardButton.dataset.cardbutton,c.id)}catch(err){toast(err.message)}return}
    const watch=e.target.closest('[data-watch]');
    if(watch){
      await api(cardApi(c.id)+'/watch',{method:'POST',body:JSON.stringify({active:watch.dataset.on!=='true'})});
      await openCard(c.id,tab);refreshBoard(true);return;
    }
    const vote=e.target.closest('[data-vote]');
    if(vote){
      await api(cardApi(c.id)+'/vote',{method:'POST',body:JSON.stringify({active:vote.dataset.on!=='true'})});
      await openCard(c.id,tab);refreshBoard(true);return;
    }
    if(e.target.closest('[data-boost]')){
      formModal('Boost '+c.id,[{name:'text',label:'short support (12 characters max)',required:true,placeholder:'ship it 🚀'}],'boost',async d=>{
        if([...d.text].length>12)throw new Error('a boost may be at most 12 characters');
        await api(cardApi(c.id)+'/boost',{method:'POST',body:JSON.stringify({text:d.text})});
        refreshBoard(true);setTimeout(()=>openCard(c.id,tab),0);
      });
      return;
    }
    if(e.target.closest('[data-feedcard]')){
      formModal('Feed for '+c.id,[{name:'label',label:'private feed name',required:true,value:c.id+' '+c.title}],'create feed',async d=>{
        NEW_FEED=await api('/api/projects/'+SEL+'/feeds',{method:'POST',body:JSON.stringify({label:d.label,card:c.id})});
        VIEW='feeds';renderMain();
      });
      return;
    }
    const promote=e.target.closest('[data-promote]');
    if(promote){
      const r=await api('/api/projects/'+SEL+'/cards/'+c.id+'/promote',{method:'POST',body:JSON.stringify({index:Number(promote.dataset.promote)})});
      await reloadOrg();BOARD=null;openCard(r.promoted,'card');refreshBoard(true);return}
    const unlink=e.target.closest('[data-unlinkcard]');
    if(unlink){try{await api('/api/projects/'+SEL+'/cards/'+c.id+'/unlink',{method:'POST',body:JSON.stringify({target:unlink.dataset.unlinkcard,type:unlink.dataset.reltype})});openCard(c.id,'card');refreshBoard(true)}catch(err){toast(err.message)}return}
    if(e.target.closest('[data-linkcard]')){
      const here=findAny(SEL),projects=[{id:SEL,name:(here&&here.name)||'this project'}].concat(handoffTargets());
      formModal('Link card',[{name:'project',label:'target project',type:'select',options:projects.map((p,i)=>({value:p.id,label:(i===0?'this project · ':'nested project · ')+p.name}))},{name:'target',label:'target card id',required:true},{name:'type',label:'relation',type:'select',options:['relates','duplicates','supersedes','parent','subtask','copied-from','copied-to','recurs-from','recurs-to'].map(x=>({value:x,label:x}))}],'link',async d=>{
        const target=d.project===SEL?d.target:'project:'+d.project+'#'+d.target;
        await api('/api/projects/'+SEL+'/cards/'+c.id+'/link',{method:'POST',body:JSON.stringify({target,type:d.type})});setTimeout(()=>openCard(c.id,'card'),0);refreshBoard(true)});
      return}
    const chk=e.target.closest('[data-check]');
    if(chk){await api('/api/projects/'+SEL+'/cards/'+c.id+'/check',{method:'POST',body:JSON.stringify({index:Number(chk.dataset.check),checked:chk.dataset.on!=='true'})});openCard(c.id,'card');return}
    const det=e.target.closest('[data-detach]');
    if(det){await api('/api/projects/'+SEL+'/cards/'+c.id+'/detach',{method:'POST',body:JSON.stringify({index:Number(det.dataset.detach)})});openCard(c.id,'card');return}
    const cov=e.target.closest('[data-cover]');
    if(cov){const v=cov.dataset.cover;await api('/api/projects/'+SEL+'/cards/'+c.id+'/edit',{method:'POST',body:JSON.stringify({cover:v==='auto'?null:v})});openCard(c.id,'card');return}
    if(e.target.closest('[data-upload]')){
      const picker=document.createElement('input');picker.type='file';
      picker.onchange=async()=>{
        const file=picker.files&&picker.files[0];if(!file)return;
        const pane=m.querySelector('.pane');
        const fail=msg=>pane.insertAdjacentHTML('afterbegin','<div class="err" role="alert">'+esc(msg)+'</div>');
        if(file.size>10*1024*1024)return void fail('that file is over the 10 MiB upload limit');
        const res=await fetch('/api/projects/'+SEL+'/cards/'+c.id+'/upload?name='+encodeURIComponent(file.name),{
          method:'POST',headers:{'content-type':file.type||'application/octet-stream',...(TOKEN?{authorization:'Bearer '+TOKEN}:{})},body:file});
        if(res.ok)openCard(c.id,'card');
        else{const b=await res.json().catch(()=>({}));fail(b.error||'upload failed')}
      };
      picker.click();
      return}
    if(e.target.closest('[data-attach]')){
      formModal('Attach a link',[{name:'url',label:'url (images join the gallery)',required:true},{name:'label',label:'label (optional)'}],'attach',async d=>{
        await api('/api/projects/'+SEL+'/cards/'+c.id+'/attach',{method:'POST',body:JSON.stringify({url:d.url,label:d.label||undefined})});openCard(c.id,'card')});
      return}
    if(e.target.closest('[data-desc]')){
      formModal('Edit description',[{name:'text',label:'description (markdown; empty clears)',type:'textarea',rows:9,value:(c.parsed&&c.parsed.description)||''}],'save',async d=>{
        await api('/api/projects/'+SEL+'/cards/'+c.id+'/describe',{method:'POST',body:JSON.stringify({text:d.text})});openCard(c.id,'card')});
      return}
    const ai=e.target.closest('[data-additem]');
    if(ai){
      formModal('Add task',[{name:'text',label:'task',required:true}],'add task',async d=>{
        await api('/api/projects/'+SEL+'/cards/'+c.id+'/checkadd',{method:'POST',body:JSON.stringify({text:d.text,section:ai.dataset.additem})});openCard(c.id,'card')});
      return}
    if(e.target.closest('[data-sharecard]')){
      formModal('Share this card',[{name:'label',label:'label (for your own bookkeeping)',required:true,value:c.id+' '+c.title}],'create link',async d=>{
        const r=await api('/api/projects/'+SEL+'/shares',{method:'POST',body:JSON.stringify({label:d.label,card:c.id})});
        setTimeout(()=>{ // after the form modal closes itself
          const m2=overlay('<h3>Card link is live</h3><p style="font-size:13px;color:var(--ink2)">Anyone with this url sees exactly this card, read only.</p>'
            +'<div class="tokenbox">'+location.origin+'/s/'+esc(r.token)+'</div>'
            +'<div class="actions"><button class="primary" data-x2>done</button></div>',null,'Card link');
          m2.querySelector('[data-x2]').onclick=()=>{closeOverlay();openCard(c.id,'card')};
        },0);
      });
      return}
    if(e.target.closest('[data-mergecard]')){
      formModal('Merge duplicate',[{name:'canonical',label:'canonical card id',required:true}],'merge and archive',async d=>{
        await api('/api/projects/'+SEL+'/cards/'+c.id+'/merge',{method:'POST',body:JSON.stringify({canonical:d.canonical})});
        await reloadOrg();setTimeout(()=>openCard(d.canonical,'card'),0);refreshBoard(true)});
      return}
    if(e.target.closest('[data-transfercard]')){
      const targets=handoffTargets();
      if(!targets.length){toast('This project has no nested handoff targets.');return}
      formModal('Handoff card',[
        {name:'target',label:'target project',type:'select',options:targets.map(p=>({value:p.id,label:p.name}))},
        {name:'mode',label:'operation',type:'select',options:[{value:'copy',label:'copy (keep source active)'},{value:'move',label:'move (archive source after safe copy)'}]},
        {name:'lane',label:'target lane (optional)'},
      ],'handoff',async d=>{
        const r=await api('/api/projects/'+SEL+'/cards/'+c.id+'/transfer',{method:'POST',body:JSON.stringify({target:d.target,move:d.mode==='move',lane:d.lane||undefined})});
        await reloadOrg();setTimeout(()=>{SEL=r.project;VIEW='board';BOARD=null;renderSide();renderMain();openCard(r.target,'card')},0);
      });
      return}
    // Claim is a coordination primitive: losing is a normal outcome, not an
    // error, so a lost claim explains itself and (for owners only) offers the
    // override the spec allows a human operator.
    if(e.target.closest('[data-claim]')){
      const act=async(force,wipReason)=>{
        const r=await api(cardApi(c.id)+'/claim',{method:'POST',body:JSON.stringify({...(force?{force:true}:{}),...(wipReason?{wipReason:wipReason}:{})})});
        closeOverlay();await reloadOrg();setTimeout(()=>openCard(c.id,'card'),0);
        if(r&&r.alreadyYours)toast('You already hold '+c.id+'.');
      };
      if(maybeWipPrompt(c,'doing','Claim',x=>act(x.force===true,x.wipReason)))return;
      try{await act(false)}
      catch(err){
        if(err.status!==409)return toast(err.message);
        const conflict=(err.body&&err.body.conflict)||null;
        const m=overlay('<h3>Cannot claim '+esc(c.id)+'</h3>'+conflictHtml(conflict,err.message)
          +'<div class="err" role="alert"></div><div class="actions"><button class="ghost" data-x3>leave it</button>'
          +(IS_OWNER?'<button class="danger" data-force>take it anyway</button>':'')+'</div>',null,'Cannot claim');
        m.querySelector('[data-x3]').onclick=closeOverlay;
        const f=m.querySelector('[data-force]');
        if(f)f.onclick=async()=>{
          f.disabled=true;f.textContent='taking…';
          try{await act(true)}catch(e2){$('.err',m).textContent=e2.message;f.disabled=false;f.textContent='take it anyway'}
        };
      }
      return}
    if(e.target.closest('[data-close]')){
      const lane=(BOARD&&BOARD.lanes||[]).find(l=>l.canonical==='done');
      const overflow=!!lane&&c.lane!==lane.id&&lane.wip!=null&&lane.cards.length>=lane.wip;
      const denied=overflow&&lane.wipMode==='deny';
      if(denied&&!IS_OWNER){toast(lane.name+' denies WIP overflow ('+(lane.cards.length+1)+'/'+lane.wip+').');return}
      const fields=[{name:'reason',label:'what holds now (optional)'}]
        .concat(overflow&&lane.wipMode!=='allow'?[{name:'wipReason',label:denied?'owner override justification':'written WIP justification',required:true}]:[]);
      formModal('Close '+c.id,fields,'close',async d=>{
        await api(cardApi(c.id)+'/close',{method:'POST',body:JSON.stringify({...(d.reason?{reason:d.reason}:{}),
          ...(d.wipReason?{wipReason:d.wipReason}:{}),...(denied?{force:true}:{})})});
        await reloadOrg();
        setTimeout(()=>openCard(c.id,'card'),0); // after the form modal closes itself
      });
      return}
    if(e.target.closest('[data-block]')){
      const blockers=(BOARD&&BOARD.blockers)||[];
      formModal('Block '+c.id,[
        ...(blockers.length?[{name:'blocker',label:'named blocker',type:'select',options:[{value:'',label:'unclassified'}].concat(blockers.map(b=>({value:b.id,label:b.name})))}]:[]),
        {name:'reason',label:'why it is parked',required:true},
      ],'block',async d=>{
        await api(cardApi(c.id)+'/block',{method:'POST',body:JSON.stringify({reason:d.reason,blocker:d.blocker||undefined})});
        await reloadOrg();
        setTimeout(()=>openCard(c.id,'card'),0); // after the form modal closes itself
      });
      return}
    if(e.target.closest('[data-unblock]')){
      await api(cardApi(c.id)+'/unblock',{method:'POST',body:JSON.stringify({})});
      await reloadOrg();openCard(c.id,'card');
      return}
    if(e.target.closest('[data-snooze]')){
      formModal('Snooze '+c.id,[{name:'until',label:'until (YYYY-MM-DD or UTC datetime)',required:true}],'snooze',async d=>{
        await api(cardApi(c.id)+'/snooze',{method:'POST',body:JSON.stringify({until:d.until})});
        await reloadOrg();setTimeout(()=>openCard(c.id,'card'),0);
      });
      return}
    if(e.target.closest('[data-wake]')){
      await api(cardApi(c.id)+'/snooze',{method:'POST',body:JSON.stringify({until:null})});
      await reloadOrg();openCard(c.id,'card');return}
    if(e.target.closest('[data-editcard]')){
      const defs=(BOARD&&BOARD.fields)||[];
      const fields=[
        {name:'title',label:'title',required:true,value:c.title},
        {name:'priority',label:'priority (p0 to p3, empty for none)',value:c.priority||''},
        {name:'labels',label:'labels (comma separated)',value:(c.labels||[]).join(', ')},
        {name:'deps',label:'deps (comma separated card ids)',value:(c.deps||[]).join(', ')},
        {name:'assignee',label:'accountable assignee (empty to clear)',value:c.assignee||''},
        {name:'delegate',label:'executing delegate (empty to clear)',value:c.delegate||''},
        {name:'start',label:'start (empty to clear)',value:c.start||''},
        {name:'due',label:'due (empty to clear)',value:c.due||''},
        {name:'reminders',label:'reminders before due (minutes, comma separated; empty clears)',value:(c.reminders||[]).join(', ')},
        {name:'repeat_every',label:'repeat every (empty clears recurrence)',type:'number',value:c.repeat&&c.repeat.every||''},
        {name:'repeat_unit',label:'repeat unit',type:'select',value:c.repeat&&c.repeat.unit||'day',options:[{value:'day',label:'days'},{value:'week',label:'weeks'},{value:'month',label:'months'}]},
        {name:'repeat_from',label:'next dates from',type:'select',value:c.repeat&&c.repeat.from||'due',options:[{value:'due',label:'the prior due date'},{value:'completion',label:'completion time'}]},
        {name:'snooze',label:'snooze until (empty wakes)',value:c.snooze||''},
        {name:'estimate',label:'estimate (empty to clear)',type:'number',value:c.estimate??''},
        {name:'hill',label:'hill position (0–100, empty to clear)',type:'number',value:c.hill??''},
        {name:'evergreen',label:'aging signal',type:'select',value:String(!!c.evergreen),options:[{value:'false',label:'normal'},{value:'true',label:'evergreen (hide aging)'}]},
        {name:'cover_color',label:'cover color (empty to clear)',value:c.coverColor||''},
      ].concat(customFormFields(defs,c.fields||[]));
      formModal('Edit card',fields,'save',async d=>{
        await api('/api/projects/'+SEL+'/cards/'+c.id+'/edit',{method:'POST',body:JSON.stringify({
          title:d.title,priority:d.priority||null,assignee:d.assignee||null,
          delegate:d.delegate||null,start:d.start||null,due:d.due||null,
          reminders:d.reminders?d.reminders.split(',').map(s=>Number(s.trim())):[],
          repeat:d.repeat_every?{every:Number(d.repeat_every),unit:d.repeat_unit,from:d.repeat_from}:null,
          snooze:d.snooze||null,
          estimate:d.estimate?Number(d.estimate):null,evergreen:d.evergreen==='true',cover_color:d.cover_color||null,
          hill:d.hill===''?null:Number(d.hill),
          labels:d.labels?d.labels.split(',').map(s=>s.trim()).filter(Boolean):[],
          deps:d.deps?d.deps.split(',').map(s=>s.trim()).filter(Boolean):[],fields:customPayload(defs,d,true)})});
        openCard(c.id,'card');refreshBoard(true)});
    }
  });
  m.addEventListener('keydown',async e=>{
    if(RO||(e.key!=='Enter'&&e.key!==' '))return;
    const chk=checklistKeyTarget(e.target);
    if(chk){e.preventDefault();
      await api('/api/projects/'+SEL+'/cards/'+c.id+'/check',{method:'POST',body:JSON.stringify({index:Number(chk.dataset.check),checked:chk.dataset.on!=='true'})});
      openCard(c.id,'card')}
  });
  const composer=m.querySelector('.composer');
  if(composer)composer.onsubmit=async e=>{e.preventDefault();
    const input=composer.querySelector('input');
    await api('/api/projects/'+SEL+'/cards/'+c.id+'/comment',{method:'POST',body:JSON.stringify({message:input.value})});
    openCard(c.id,'chat')};
}
// ---- activity + keys + settings ----
const PROJECT_EVENT_PAGE_SIZE=50;
function refreshActivity(){
  const host=$('#view'),project=SEL,pages=[];
  let pageIndex=-1,loading=false,failure='';
  const current=()=>host&&host.isConnected&&VIEW==='activity'&&SEL===project;
  const paint=()=>{
    if(!current())return;
    const page=pages[pageIndex];
    if(!page){host.innerHTML=loading?'loading…':failure?'<div class="err">'+esc(failure)+'</div>':'<div class="empty">no activity yet</div>';return}
    const table=page.items.length?'<table class="list"><tr><th>when</th><th>actor</th><th>action</th><th>card</th><th>detail</th></tr>'
      +page.items.map(e=>'<tr><td class="mono">'+esc((e.ts||'').replace('T',' ').slice(0,16))+'</td><td>'+esc(e.actor)+'</td><td>'+esc(e.action)+'</td><td class="mono">'+esc(e.card_id||'')+'</td><td>'+esc(e.detail)+'</td></tr>').join('')+'</table>'
      :'<div class="empty">no activity yet</div>';
    const hasNewer=pageIndex>0,hasOlder=pageIndex+1<pages.length||page.hasMore;
    const pager=hasNewer||hasOlder?'<nav aria-label="Project activity pages" style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px">'
      +'<button type="button" data-event-prev'+(hasNewer&&!loading?'':' disabled')+'>← newer</button>'
      +'<span class="setting-note" style="margin:0">page '+(pageIndex+1)+' · '+PROJECT_EVENT_PAGE_SIZE+' per page</span>'
      +'<button type="button" data-event-next'+(hasOlder&&!loading?'':' disabled')+'>'+(loading?'loading…':'older →')+'</button></nav>':'';
    host.innerHTML=table+pager+(failure?'<div class="err">'+esc(failure)+'</div>':'');
    const previous=host.querySelector('[data-event-prev]');
    if(previous)previous.onclick=()=>{pageIndex--;failure='';paint()};
    const next=host.querySelector('[data-event-next]');
    if(next)next.onclick=()=>{
      if(pageIndex+1<pages.length){pageIndex++;failure='';paint();return}
      const last=page.items[page.items.length-1];if(last)load(last.seq);
    };
  };
  const load=async before=>{
    if(loading)return;loading=true;failure='';paint();
    try{
      const cursor=before==null?'':'&before='+encodeURIComponent(before);
      const list=await api('/api/projects/'+project+'/events?limit='+(PROJECT_EVENT_PAGE_SIZE+1)+cursor);
      if(!current())return;
      if(!Array.isArray(list))throw new Error('Invalid project activity response.');
      pages.splice(pageIndex+1);
      pages.push({items:list.slice(0,PROJECT_EVENT_PAGE_SIZE),hasMore:list.length>PROJECT_EVENT_PAGE_SIZE});pageIndex++;
    }catch(err){failure=err.message}
    finally{loading=false;paint()}
  };
  load(null);
}
// ---- my account: password + my own api keys ----
// A key label is a note to self ("laptop", "CI"). It is NOT an identity: the
// board shows your display name, which only an owner can change. That
// distinction is spelled out in the UI because conflating the two is exactly
// what made the old per-project "agent key label" confusing.
async function renderAccount(host){
  let keys=[];
  try{keys=await api('/api/keys')}catch(err){host.innerHTML='<div class="err">'+esc(err.message)+'</div>';return}
  host.innerHTML='<p class="setting-note">You are <b>'+esc(ME.display)+'</b> (<code>'+esc(ME.username)+'</code>), '
    +esc(ME.role)+' on '+esc(ME.scope.kind)+'. Cards you touch are logged under your username; boards render your display name.</p>'
    +'<p style="margin:10px 0"><button id="chpw">change password</button> '
    +'<button class="primary" id="mk">+ api key</button></p>'
    +'<p class="setting-note">An api key is an alternative to sending your password: same identity, same scope, revocable on its own. Bots can use either.</p>'
    +(keys.length?'<table class="list"><tr><th>name</th><th>id</th><th>created</th><th>last used</th><th></th></tr>'
      +keys.map(k=>'<tr'+(k.revoked?' style="opacity:.5"':'')+'><td>'+esc(k.label)+'</td><td class="mono">'+esc(k.id)+'</td>'
        +'<td class="mono">'+esc(k.created.slice(0,10))+'</td><td class="mono">'+esc(k.lastUsed?k.lastUsed.slice(0,10):'never')+'</td>'
        +'<td>'+(k.revoked?'revoked':'<button data-renk="'+esc(k.id)+'" data-label="'+esc(k.label)+'">rename</button> <button data-repk="'+esc(k.id)+'">replace</button> <button data-rk="'+esc(k.id)+'">revoke</button>')+'</td></tr>').join('')+'</table>'
      :'<div class="empty">no api keys yet</div>');
  $('#chpw').onclick=()=>formModal('Change password',[
    {name:'current',label:'current password',type:'password',required:true},
    {name:'next',label:'new password (8+ characters)',type:'password',required:true},
  ],'change',async d=>{
    const r=await api('/api/me/password',{method:'POST',body:JSON.stringify({current:d.current,next:d.next})});
    // The reset ended every session including this one; adopt the fresh token.
    TOKEN=r.token;localStorage.setItem('bf_token',TOKEN);
  });
  $('#mk').onclick=()=>formModal('New api key',[{name:'label',label:'name (optional: defaults to "api key #N")'}],'mint',async d=>{
    const r=await api('/api/keys',{method:'POST',body:JSON.stringify(d.label?{label:d.label}:{})});
    await renderAccount(host);
    host.insertAdjacentHTML('afterbegin','<div class="tokenbox">'+esc(r.token)+'</div><p class="warn">Copy '+esc(r.label)+' now: it is never shown again.</p>');
  });
  host.onclick=async e=>{
    const ren=e.target.closest('[data-renk]');
    if(ren)return formModal('Rename key',[{name:'label',label:'name',value:ren.dataset.label,required:true}],'save',async d=>{
      await api('/api/keys/'+ren.dataset.renk,{method:'PATCH',body:JSON.stringify({label:d.label})});await renderAccount(host)});
    const rev=e.target.closest('[data-rk]');
    if(rev)return confirmModal('Revoke key','That credential stops working immediately. Anything using it will start getting 401s.','revoke',async()=>{
      await api('/api/keys/'+rev.dataset.rk+'/revoke',{method:'POST'});await renderAccount(host)});
    const replace=e.target.closest('[data-repk]');
    if(replace)return confirmModal('Replace key','A new one-time secret will replace this credential. The old key stops working immediately.','replace',async()=>{
      const r=await api('/api/keys/'+replace.dataset.repk+'/replace',{method:'POST'});await renderAccount(host);
      host.insertAdjacentHTML('afterbegin','<div class="tokenbox">'+esc(r.token)+'</div><p class="warn">Copy replacement '+esc(r.label)+' now: it is never shown again.</p>')});
  };
}
// ---- members: the company directory, owner only ----
// /api/members returns Registry Identity rows: scopeKind/scopeId are flat.
// Accept the old nested presentation shape too, and quarantine malformed rows
// instead of letting one bad member make the entire directory disappear.
function memberScope(m){
  const nested=m&&m.scope&&typeof m.scope==='object'?m.scope:null;
  const kind=['org','space','project'].includes(m&&m.scopeKind)?m.scopeKind:['org','space','project'].includes(nested&&nested.kind)?nested.kind:null;
  const raw=m&&m.scopeId!==undefined?m.scopeId:nested&&nested.id;
  const id=typeof raw==='string'&&raw!==''?raw:null;
  return kind==='org'?{kind:'org',id:null}:kind&&(id!==null)?{kind:kind,id:id}:{kind:null,id:null};
}
function scopeLabel(m){
  const scope=memberScope(m);if(scope.kind===null)return 'scope unavailable';
  if(scope.kind==='org')return 'whole company';
  if(scope.kind==='space'){const sp=ORG.spaces.find(x=>x.id===scope.id);return 'space: '+(sp?sp.name:scope.id)}
  const p=findAny(scope.id);return 'project: '+(p?p.name:scope.id);
}
function scopeOptions(sel,allowOrg=true){
  let out=sel===null?'<option value="" selected disabled>scope unavailable — choose a scope</option>':'';
  if(allowOrg)out+='<option value="org"'+(sel==='org'?' selected':'')+'>whole company (all spaces and projects)</option>';
  for(const sp of ORG.spaces){
    out+='<option value="space:'+esc(sp.id)+'"'+(sel==='space:'+sp.id?' selected':'')+'>space: '+esc(sp.name)+'</option>';
    const walk=(nodes,depth)=>{for(const n of nodes){
      out+='<option value="project:'+esc(n.id)+'"'+(sel==='project:'+n.id?' selected':'')+'>'+'\u00a0'.repeat(depth*4)+'project: '+esc(n.name)+'</option>';
      walk(n.children,depth+1)}};
    walk(sp.projects,1);
  }
  return out;
}
function memberFields(m){
  const scope=m?memberScope(m):{kind:'org',id:null};
  const sel=scope.kind===null?null:scope.kind==='org'?'org':scope.kind+':'+scope.id;
  return '<div class="field"><label>display name<input id="mdisplay" value="'+esc(m?m.display:'')+'" placeholder="what boards show"></label></div>'
    +'<div class="field"><label>role<select id="mrole">'
    +['read','write','admin','owner'].map(r=>'<option value="'+r+'"'+(m&&m.role===r?' selected':'')+'>'+r+(r==='owner'?' (runs the company)':r==='admin'?' (shapes scoped boards)':r==='write'?' (works the board)':' (looks, cannot touch)')+'</option>').join('')
    +'</select></label></div>'
    +'<div class="field"><label>scope<select id="mscope">'+scopeOptions(sel,!m||m.role!=='admin')+'</select></label></div>';
}
function wireMemberFields(){
  const role=$('#mrole'),scope=$('#mscope');if(!role||!scope)return;
  const sync=()=>{
    const current=scope.value;
    if(role.value==='owner'){scope.innerHTML=scopeOptions('org',true);scope.disabled=true;return}
    scope.disabled=false;
    const first=ORG.spaces.length?'space:'+ORG.spaces[0].id:null;
    const selected=role.value==='admin'&&current==='org'?first:(current||null);
    scope.innerHTML=scopeOptions(selected,role.value!=='admin');
  };
  role.onchange=sync;sync();
}
function readMemberFields(){
  const raw=$('#mscope').value;
  const cut=raw.indexOf(':');
  return {
    display:$('#mdisplay').value.trim()||undefined,
    role:$('#mrole').value,
    scopeKind:cut<0?raw:raw.slice(0,cut),
    scopeId:cut<0?null:raw.slice(cut+1),
  };
}
function memberRow(m){
  const botKey=m.kind==='bot'
    ?'<button data-keym="'+esc(m.memberId)+'" aria-label="manage API keys for '+esc(m.username)+'">keys</button> '
    :'';
  return '<tr'+(m.disabled?' style="opacity:.5"':'')+'><td>'+esc(m.display)+'</td><td class="mono">'+esc(m.username)+'</td>'
    +'<td>'+esc(m.kind)+'</td><td>'+esc(m.role)+'</td><td>'+esc(scopeLabel(m))+'</td>'
    +'<td class="mono" data-keycount="'+esc(m.memberId)+'">'+esc(m.keys)+'</td>'
    +'<td>'+botKey+'<button data-edm="'+esc(m.memberId)+'">edit</button> <button data-pwm="'+esc(m.memberId)+'">password</button>'
    +(m.username===ME.username?'':' <button data-delm="'+esc(m.memberId)+'" data-name="'+esc(m.display)+'">remove</button>')+'</td></tr>';
}
function provisionBotKey(m,host){
  const title='API keys for '+m.username;
  const dlg=overlay('<h3>'+esc(title)+'</h3><p>loading…</p>','wide',title);
  let keys=[];
  const endpoint='/api/keys?member='+encodeURIComponent(m.memberId);
  const syncCount=()=>{
    m.keys=keys.filter(k=>!k.revoked).length;
    const count=[...host.querySelectorAll('[data-keycount]')].find(x=>x.dataset.keycount===m.memberId);
    if(count)count.textContent=String(m.keys);
  };
  const noticeHtml=notice=>notice?'<div class="tokenbox">'+esc(notice.token)+'</div>'
    +'<p class="warn">Copy '+esc(notice.label)+' now. It is never shown again.</p>'
    +'<p><button type="button" class="ghost" data-copybotkey="'+esc(notice.token)+'">copy key</button></p>':'';
  const paint=notice=>{
    syncCount();
    dlg.innerHTML='<h3>'+esc(title)+'</h3>'
      +'<p class="setting-note">Each credential acts as <code>'+esc(m.username)+'</code>: '+esc(m.role)+' on '+esc(scopeLabel(m))+'. The bot does not need to log in. Secret material is shown only when minted or replaced.</p>'
      +noticeHtml(notice)
      +'<p style="margin:10px 0"><button type="button" class="primary" data-newbotkey>+ API key</button></p>'
      +(keys.length?'<table class="list"><tr><th>name</th><th>id</th><th>created</th><th>last used</th><th></th></tr>'
        +keys.map(k=>'<tr'+(k.revoked?' style="opacity:.5"':'')+'><td>'+esc(k.label)+'</td><td class="mono">'+esc(k.id)+'</td>'
          +'<td class="mono">'+esc((k.created||'').slice(0,10))+'</td><td class="mono">'+esc(k.lastUsed?(k.lastUsed||'').slice(0,10):'never')+'</td><td>'
          +(k.revoked?'revoked':'<button type="button" data-renbotkey="'+esc(k.id)+'" data-label="'+esc(k.label)+'">rename</button> <button type="button" data-repbotkey="'+esc(k.id)+'">replace</button> <button type="button" data-revbotkey="'+esc(k.id)+'">revoke</button>')+'</td></tr>').join('')+'</table>'
        :'<div class="empty">no API keys yet</div>')
      +'<div class="err" role="alert"></div><div class="actions"><button type="button" class="primary" data-closebotkeys>done</button></div>';
  };
  const load=async notice=>{
    keys=await api(endpoint);if(!Array.isArray(keys))throw new Error('Invalid key-list response.');paint(notice);
  };
  const actionForm=(heading,value,label,run)=>{
    dlg.innerHTML='<h3>'+esc(heading)+'</h3><form><div class="field"><label>name<input name="label" value="'+esc(value||'')+'" placeholder="optional: defaults to api key #N"'+(label==='save'?' required':'')+'></label></div>'
      +'<div class="err" role="alert"></div><div class="actions"><button type="button" class="ghost" data-backbotkeys>cancel</button><button class="primary">'+esc(label)+'</button></div></form>';
    $('[data-backbotkeys]',dlg).onclick=()=>paint(null);
    $('form',dlg).onsubmit=async e=>{e.preventDefault();const submit=$('button.primary',dlg);submit.disabled=true;submit.textContent='working…';
      try{const result=await run($('[name="label"]',dlg).value.trim());await load(result&&result.token?result:null)}
      catch(err){$('.err',dlg).textContent=err.message;submit.disabled=false;submit.textContent=label}};
    $('[name="label"]',dlg).focus();
  };
  const actionConfirm=(heading,message,label,run)=>{
    dlg.innerHTML='<h3>'+esc(heading)+'</h3><p style="font-size:13px;color:var(--ink2);line-height:1.55">'+esc(message)+'</p>'
      +'<div class="err" role="alert"></div><div class="actions"><button type="button" class="ghost" data-backbotkeys>cancel</button><button type="button" class="danger" data-confirmbotkey>'+esc(label)+'</button></div>';
    $('[data-backbotkeys]',dlg).onclick=()=>paint(null);
    $('[data-confirmbotkey]',dlg).onclick=async()=>{const submit=$('[data-confirmbotkey]',dlg);submit.disabled=true;submit.textContent='working…';
      try{const result=await run();await load(result&&result.token?result:null)}
      catch(err){$('.err',dlg).textContent=err.message;submit.disabled=false;submit.textContent=label}};
  };
  dlg.onclick=e=>{
    const close=e.target.closest('[data-closebotkeys]');if(close){closeOverlay();return}
    const copy=e.target.closest('[data-copybotkey]');if(copy){navigator.clipboard.writeText(copy.dataset.copybotkey).then(()=>copy.textContent='copied',()=>copy.textContent='copy failed');return}
    if(e.target.closest('[data-newbotkey]')){actionForm('New API key for '+m.username,'','mint key',label=>api(endpoint,{method:'POST',body:JSON.stringify(label?{label}:{})}));return}
    const rename=e.target.closest('[data-renbotkey]');if(rename){actionForm('Rename '+m.username+' key',rename.dataset.label,'save',label=>api('/api/keys/'+rename.dataset.renbotkey,{method:'PATCH',body:JSON.stringify({label})}));return}
    const replace=e.target.closest('[data-repbotkey]');if(replace){actionConfirm('Replace '+m.username+' key','The current credential stops working as soon as its one-time replacement is minted.','replace',()=>api('/api/keys/'+replace.dataset.repbotkey+'/replace',{method:'POST'}));return}
    const revoke=e.target.closest('[data-revbotkey]');if(revoke)actionConfirm('Revoke '+m.username+' key','This credential stops working immediately.','revoke',()=>api('/api/keys/'+revoke.dataset.revbotkey+'/revoke',{method:'POST'}));
  };
  load(null).catch(err=>{dlg.innerHTML='<h3>'+esc(title)+'</h3><div class="err">'+esc(err.message)+'</div><div class="actions"><button type="button" class="primary" data-x>done</button></div>';$('[data-x]',dlg).onclick=closeOverlay});
}
async function renderMembers(host,focusId){
  let members=[];
  try{members=await api('/api/members')}catch(err){host.innerHTML='<div class="err">'+esc(err.message)+'</div>';return}
  if(!host.isConnected)return;
  if(!Array.isArray(members)){host.innerHTML='<div class="err">Invalid member-directory response.</div>';return}
  host.innerHTML='<p style="margin-bottom:10px"><button class="primary" id="addm">+ member</button>'
    +' <span style="color:var(--muted);font-size:12px">people and bots. A username is permanent (cards are logged under it); a display name is not.</span></p>'
    +'<table class="list"><tr><th>display name</th><th>username</th><th>type</th><th>role</th><th>scope</th><th>keys</th><th></th></tr>'
    +members.map(memberRow).join('')
    +'</table>';
  if(focusId){const target=[...host.querySelectorAll('[data-edm]')].find(x=>x.dataset.edm===focusId)||$('#addm');if(target)target.focus()}
  $('#addm').onclick=()=>{
    const m=overlay('<h3>New member</h3>'
      +'<div class="field"><label>username<input id="musername" placeholder="a-z, 0-9, - and _" autocomplete="off"></label></div>'
      +'<p class="setting-note">Permanent: it is the actor name written into every card log.</p>'
      +'<div class="field"><label>type<select id="mkind"><option value="human">human</option><option value="bot">bot</option></select></label></div>'
      +'<div class="field"><label>password<input id="mpw" type="password" placeholder="8+ characters" autocomplete="new-password"></label></div>'
      +memberFields(null)
      +'<div class="err" id="merr"></div><div class="actions"><button id="mcancel">cancel</button><button class="primary" id="mok">create</button></div>',
      '','New member');
    wireMemberFields();
    $('#mcancel').onclick=closeOverlay;
    $('#mok').onclick=async()=>{
      try{
        const created=await api('/api/members',{method:'POST',body:JSON.stringify({
          username:$('#musername').value.trim(),kind:$('#mkind').value,password:$('#mpw').value,...readMemberFields()})});
        closeOverlay();await renderMembers(host,created.id);await reloadOrg();
      }catch(err){$('#merr').textContent=err.message}
    };
  };
  host.onclick=async e=>{
    const key=e.target.closest('[data-keym]');
    if(key){const bot=members.find(x=>x.memberId===key.dataset.keym&&x.kind==='bot');if(bot)provisionBotKey(bot,host);return}
    const ed=e.target.closest('[data-edm]');
    if(ed){
      const m=members.find(x=>x.memberId===ed.dataset.edm);
      const dlg=overlay('<h3>Edit '+esc(m.username)+'</h3>'+memberFields(m)
        +'<div class="field"><label class="row"><input type="checkbox" id="mdis"'+(m.disabled?' checked':'')+'> disabled (every session ends)</label></div>'
        +'<p class="setting-note">Renaming updates this member everywhere on every board at once. The username stays as it is: card history is not rewritten.</p>'
        +'<div class="err" id="merr"></div><div class="actions"><button id="mcancel">cancel</button><button class="primary" id="mok">save</button></div>',
        '','Edit member');
      wireMemberFields();
      $('#mcancel').onclick=closeOverlay;
      $('#mok').onclick=async()=>{
        try{
          await api('/api/members/'+m.memberId,{method:'PATCH',body:JSON.stringify({...readMemberFields(),disabled:$('#mdis').checked})});
          closeOverlay();await renderMembers(host,m.memberId);await reloadOrg();
        }catch(err){$('#merr').textContent=err.message}
      };
      return;
    }
    const pw=e.target.closest('[data-pwm]');
    if(pw)return formModal('Set password',[{name:'password',label:'new password (8+ characters)',type:'password',required:true}],'set',async d=>{
      await api('/api/members/'+pw.dataset.pwm+'/password',{method:'POST',body:JSON.stringify({password:d.password})});await renderMembers(host,pw.dataset.pwm);await reloadOrg()});
    const del=e.target.closest('[data-delm]');
    if(del)return confirmModal('Remove member','Removing '+esc(del.dataset.name)+' revokes every key and ends every session. The username stays reserved: it is the name already written into card logs and assignments, so it must never be handed to someone else.','remove',async()=>{
      await api('/api/members/'+del.dataset.delm,{method:'DELETE'});await renderMembers(host);await reloadOrg();const add=$('#addm');if(add)add.focus()});
  };
}
function feedScope(f,b){
  if(f.cardId)return 'card '+f.cardId;
  if(f.laneId){const lane=(b.lanes||[]).find(l=>l.id===f.laneId);return 'lane '+(lane?lane.name:f.laneId)}
  if(f.filterId){const filter=(b.filters||[]).find(x=>x.id===f.filterId);return 'filter '+(filter?filter.name:f.filterId)}
  return 'whole board';
}
function feedUrl(token,format){return location.origin+'/feeds/'+token+'.'+format}
function feedLinks(feed){
  return '<div class="feedurls">'+[
    ['atom','Atom'],['rss','RSS'],['ics','iCal'],
  ].map(x=>'<span><a href="'+esc(feedUrl(feed.token,x[0]))+'" target="_blank" rel="noopener">'+x[1]+'</a> '
    +'<button type="button" class="ghost" data-copyfeed="'+esc(feedUrl(feed.token,x[0]))+'">copy URL</button></span>').join('')+'</div>';
}
async function refreshFeeds(){
  const host=$('#view');if(!host)return;
  try{
    const [feeds,b]=await Promise.all([
      api('/api/projects/'+SEL+'/feeds'),
      BOARD?Promise.resolve(BOARD):api('/api/projects/'+SEL+'/board'),
    ]);
    if(!host.isConnected||VIEW!=='feeds')return;
    BOARD=b;
    const scopeOptions=[{value:'board',label:'whole board'}]
      .concat((b.lanes||[]).map(l=>({value:'lane:'+l.id,label:'lane: '+l.name})))
      .concat((b.filters||[]).map(f=>({value:'filter:'+f.id,label:'saved filter: '+f.name})))
      .concat([{value:'card',label:'one card (enter its id)'}]);
    const fresh=NEW_FEED?'<div class="tokenbox"><b>'+esc(NEW_FEED.label||'Feed created')+'</b><br>Copy these private capability URLs now or later from the list.'+feedLinks(NEW_FEED)
      +'<button type="button" class="ghost" data-dismissfeed>dismiss</button></div>':'';
    host.innerHTML=fresh
      +'<p style="margin-bottom:10px"><button type="button" class="primary" id="mkfeed">+ private feed</button> '
      +'<span class="setting-note">Member-scoped and read only. Slack can subscribe to RSS; calendar apps use iCal.</span></p>'
      +(feeds.length?'<table class="list"><tr><th>name</th><th>scope</th><th>formats</th><th>created</th><th>last fetched</th><th></th></tr>'
        +feeds.map(f=>'<tr'+(f.revoked?' style="opacity:.5"':'')+'><td>'+esc(f.label)+'</td><td>'+esc(feedScope(f,b))+'</td>'
          +'<td>'+(f.revoked?'revoked':feedLinks(f))+'</td><td class="mono">'+esc((f.created||'').slice(0,10))+'</td>'
          +'<td class="mono">'+esc(f.lastViewed?(f.lastViewed||'').slice(0,10):'never')+'</td><td>'
          +(f.revoked?'':'<button type="button" data-rfeed="'+esc(f.id)+'">revoke</button> ')+'<button type="button" data-dfeed="'+esc(f.id)+'">delete</button></td></tr>').join('')+'</table>'
        :'<div class="empty">no private feeds yet</div>')
      +'<p class="setting-note" style="margin-top:12px">A feed URL is a secret bearer capability. Revocation is immediate. It also stops working if your account loses this project, or if its card, lane, or saved filter scope disappears. External calendar refresh timing is controlled by the calendar provider.</p>';
    $('#mkfeed').onclick=()=>formModal('New private feed',[
      {name:'label',label:'name',required:true,value:'activity feed'},
      {name:'scope',label:'scope',type:'select',options:scopeOptions},
      {name:'card',label:'card id (only for one-card scope)'},
    ],'create feed',async d=>{
      const body={label:d.label};
      if(d.scope==='card'){
        if(!d.card)throw new Error('card id required for one-card scope');
        body.card=d.card;
      }else if(d.scope.startsWith('lane:'))body.lane=d.scope.slice(5);
      else if(d.scope.startsWith('filter:'))body.filter=d.scope.slice(7);
      NEW_FEED=await api('/api/projects/'+SEL+'/feeds',{method:'POST',body:JSON.stringify(body)});
      NEW_FEED.label=d.label;await refreshFeeds();
    });
    host.onclick=async e=>{
      const copy=e.target.closest('[data-copyfeed]');
      if(copy){try{await navigator.clipboard.writeText(copy.dataset.copyfeed);copy.textContent='copied'}catch{copy.textContent='copy failed'}return}
      if(e.target.closest('[data-dismissfeed]')){NEW_FEED=null;refreshFeeds();return}
      const revoke=e.target.closest('[data-rfeed]');
      if(revoke){confirmModal('Revoke feed','Every Atom, RSS, and iCal URL for this feed stops working immediately.','revoke',async()=>{
        await api('/api/feeds/'+revoke.dataset.rfeed+'/revoke',{method:'POST'});NEW_FEED=null;refreshFeeds()});return}
      const del=e.target.closest('[data-dfeed]');
      if(del){confirmModal('Delete feed','Delete this capability record? Its URLs will never work again.','delete',async()=>{
        await api('/api/feeds/'+del.dataset.dfeed,{method:'DELETE'});NEW_FEED=null;refreshFeeds()});return}
    };
  }catch(err){if(host.isConnected)host.innerHTML='<div class="err">'+esc(err.message)+'</div>'}
}
function integrationNoticeHtml(){
  if(!INTEGRATION_NOTICE)return '';
  return '<div class="tokenbox"><b>'+esc(INTEGRATION_NOTICE.title)+'</b><br>'+esc(INTEGRATION_NOTICE.value)
    +'<div style="margin-top:7px"><button type="button" class="ghost" data-copyintegration="'+esc(INTEGRATION_NOTICE.value)+'">copy</button> '
    +'<button type="button" class="ghost" data-dismissintegration>dismiss</button></div></div>'
    +'<p class="warn">'+esc(INTEGRATION_NOTICE.note)+'</p>';
}
function eventFilterLabel(item){
  const allow=(item.allowEvents||[]).length?(item.allowEvents||[]).join(', '):'all events';
  const deny=(item.denyEvents||[]).length?' except '+(item.denyEvents||[]).join(', '):'';
  return allow+deny;
}
function webhookDeliveriesModal(hook){
  const project=SEL,pages=[];
  let pageIndex=-1,loading=false,failure='';
  const dlg=overlay('<h3>'+esc(hook.name)+' delivery history</h3><p>loading…</p>','wide','Webhook delivery history');
  const paint=()=>{
    const page=pages[pageIndex];
    if(!page){dlg.innerHTML='<h3>'+esc(hook.name)+' delivery history</h3>'+(loading?'<p>loading…</p>':'<div class="err">'+esc(failure)+'</div>');return}
    const rows=page.deliveries;
    const hasNewer=pageIndex>0,hasOlder=pageIndex+1<pages.length||page.next!==null;
    dlg.innerHTML='<h3>'+esc(hook.name)+' delivery history</h3>'
      +'<p class="setting-note">The delivery id is stable across automatic retries; receivers should deduplicate it and reject stale timestamps.</p>'
      +(rows.length?'<table class="list"><tr><th>event</th><th>status</th><th>attempts</th><th>HTTP</th><th>when</th><th></th></tr>'
        +rows.map(d=>'<tr><td>'+esc(d.event)+'</td><td>'+esc(d.status)+(d.error?'<br><span class="err">'+esc(d.error)+'</span>':'')+'</td>'
          +'<td>'+esc(d.attempts)+'</td><td>'+esc(d.responseStatus??'')+'</td><td class="mono">'+esc((d.lastAttempt||d.created||'').replace('T',' ').slice(0,16))+'</td>'
          +'<td><button type="button" data-replaydelivery="'+esc(d.id)+'">replay</button></td></tr>').join('')+'</table>'
        :'<div class="empty">no deliveries yet</div>')
      +'<nav aria-label="Webhook delivery pages" class="actions">'
      +'<button type="button" class="ghost" data-delivery-prev'+(hasNewer&&!loading?'':' disabled')+'>← newer</button>'
      +'<span class="setting-note" style="margin:0">page '+(pageIndex+1)+'</span>'
      +'<button type="button" class="ghost" data-delivery-next'+(hasOlder&&!loading?'':' disabled')+'>older →</button>'
      +'<button type="button" class="primary" data-x>done</button></nav>'+(failure?'<div class="err">'+esc(failure)+'</div>':'');
  };
  const load=async before=>{
    if(loading)return;loading=true;failure='';paint();
    try{
      const q='?limit=25'+(before===null?'':'&before='+encodeURIComponent(before));
      const page=await api('/api/projects/'+project+'/webhooks/'+encodeURIComponent(hook.id)+'/deliveries'+q);
      if(!page||!Array.isArray(page.deliveries))throw new Error('Invalid webhook delivery response.');
      pages.splice(pageIndex+1);pages.push({deliveries:page.deliveries,next:page.next??null});pageIndex++;
    }catch(err){failure=err.message}
    finally{loading=false;paint()}
  };
  dlg.onclick=async e=>{
    if(e.target.closest('[data-x]')){closeOverlay();return}
    if(e.target.closest('[data-delivery-prev]')){pageIndex--;failure='';paint();return}
    if(e.target.closest('[data-delivery-next]')){
      if(pageIndex+1<pages.length){pageIndex++;failure='';paint();return}
      const page=pages[pageIndex];if(page&&page.next!==null)load(page.next);return;
    }
    const replay=e.target.closest('[data-replaydelivery]');
    if(replay){
      try{await api('/api/projects/'+project+'/webhooks/'+encodeURIComponent(hook.id)+'/deliveries/'+encodeURIComponent(replay.dataset.replaydelivery)+'/replay',{method:'POST',body:'{}'});toast('Webhook replay queued.');pages.length=0;pageIndex=-1;await load(null)}
      catch(err){failure=err.message;paint()}
    }
  };
  load(null);
}
function emailOutboxModal(){
  const project=SEL,pages=[];
  let pageIndex=-1,loading=false,failure='';
  const dlg=overlay('<h3>Email outbox history</h3><p>loading…</p>','wide','Email outbox history');
  const paint=()=>{
    const page=pages[pageIndex];
    if(!page){dlg.innerHTML='<h3>Email outbox history</h3>'+(loading?'<p>loading…</p>':'<div class="err">'+esc(failure)+'</div>');return}
    const rows=page.messages,hasNewer=pageIndex>0,hasOlder=pageIndex+1<pages.length||page.next!==null;
    dlg.innerHTML='<h3>Email outbox history</h3><p class="setting-note">Newest first. Lease identity and final delivery state remain available after a subscription is revoked.</p>'
      +(rows.length?'<table class="list"><tr><th>event</th><th>status</th><th>attempts</th><th>bridge</th><th>created</th></tr>'
        +rows.map(m=>'<tr><td>'+esc(m.event)+'</td><td>'+esc(m.status)+(m.error?'<br><span class="err">'+esc(m.error)+'</span>':'')+'</td><td>'+esc(m.attempts)+'</td><td>'+esc(m.leasedBy||'')+'</td><td class="mono">'+esc((m.created||'').replace('T',' ').slice(0,16))+'</td></tr>').join('')+'</table>'
        :'<div class="empty">no queued email yet</div>')
      +'<nav aria-label="Email outbox pages" class="actions"><button type="button" class="ghost" data-outbox-prev'+(hasNewer&&!loading?'':' disabled')+'>← newer</button>'
      +'<span class="setting-note" style="margin:0">page '+(pageIndex+1)+'</span><button type="button" class="ghost" data-outbox-next'+(hasOlder&&!loading?'':' disabled')+'>older →</button>'
      +'<button type="button" class="primary" data-x>done</button></nav>'+(failure?'<div class="err">'+esc(failure)+'</div>':'');
  };
  const load=async before=>{
    if(loading)return;loading=true;failure='';paint();
    try{const cursor=before===null?'':'&before='+encodeURIComponent(before);const page=await api('/api/projects/'+project+'/email/outbox?limit=25'+cursor);
      if(!page||!Array.isArray(page.messages))throw new Error('Invalid email outbox response.');
      pages.splice(pageIndex+1);pages.push({messages:page.messages,next:page.next??null});pageIndex++;
    }catch(err){failure=err.message}finally{loading=false;paint()}
  };
  dlg.onclick=e=>{
    if(e.target.closest('[data-x]')){closeOverlay();return}
    if(e.target.closest('[data-outbox-prev]')){pageIndex--;failure='';paint();return}
    if(e.target.closest('[data-outbox-next]')){if(pageIndex+1<pages.length){pageIndex++;failure='';paint();return}const page=pages[pageIndex];if(page&&page.next!==null)load(page.next)}
  };
  load(null);
}
async function refreshIntegrations(){
  const host=$('#view');if(!host)return;
  try{
    const [whResult,routeResult,subResult,outboxResult]=await Promise.all([
      api('/api/projects/'+SEL+'/webhooks'),
      api('/api/projects/'+SEL+'/email/routes'),
      api('/api/projects/'+SEL+'/email/subscriptions'),
      api('/api/projects/'+SEL+'/email/outbox?limit=25'),
    ]);
    if(!host.isConnected||VIEW!=='integrations')return;
    const hooks=whResult.webhooks||[],routes=routeResult.routes||[],subs=subResult.subscriptions||[],outbox=outboxResult.messages||[];
    host.innerHTML=integrationNoticeHtml()
      +'<h3>Outbound webhooks</h3><p class="setting-note">Signed HTTPS POSTs with redirect-by-redirect SSRF checks, durable retries, a circuit breaker, and replayable history.</p>'
      +'<p style="margin:10px 0"><button type="button" class="primary" id="mkwebhook">+ webhook</button></p>'
      +(hooks.length?'<table class="list"><tr><th>name</th><th>endpoint</th><th>events</th><th>health</th><th></th></tr>'
        +hooks.map(h=>'<tr'+(h.active?'':' style="opacity:.5"')+'><td>'+esc(h.name)+'</td><td class="mono">'+esc(h.url)+'</td><td>'+esc(eventFilterLabel(h))+'</td>'
          +'<td>'+(h.active?(h.circuitUntil?'circuit open until '+esc(h.circuitUntil.replace('T',' ').slice(0,16)):h.failureCount?esc(h.failureCount)+' consecutive failure(s)':'ready'):'revoked')+'</td>'
          +'<td><button type="button" data-whdeliveries="'+esc(h.id)+'">deliveries</button> '
          +(h.active?'<button type="button" data-whrotate="'+esc(h.id)+'">rotate secret</button> <button type="button" data-whrevoke="'+esc(h.id)+'">revoke</button>':'')+'</td></tr>').join('')+'</table>'
        :'<div class="empty">no webhooks yet</div>')
      +'<h3 style="margin-top:26px">Inbound email routes</h3><p class="setting-note">A provider bridge verifies the provider and POSTs normalized JSON to a narrow create-card or comment-only capability. Provider message IDs are deduplicated.</p>'
      +'<p style="margin:10px 0"><button type="button" class="primary" id="mkemailroute">+ inbound route</button></p>'
      +(routes.length?'<table class="list"><tr><th>name</th><th>operation</th><th>target</th><th>actor</th><th></th></tr>'
        +routes.map(r=>'<tr'+(r.active?'':' style="opacity:.5"')+'><td>'+esc(r.name)+'</td><td>'+esc(r.kind)+'</td><td class="mono">'+esc(r.kind==='comment'?'card '+r.card:(r.lane?'lane '+r.lane:'default todo lane'))+'</td><td>'+esc(r.actor)+'</td>'
          +'<td>'+(r.active?'<button type="button" data-errevoke="'+esc(r.id)+'">revoke</button>':'revoked')+'</td></tr>').join('')+'</table>'
        :'<div class="empty">no inbound routes yet</div>')
      +'<h3 style="margin-top:26px">Outbound email subscriptions</h3><p class="setting-note">Events enter a durable leased outbox. A project-scoped bot key lets your provider bridge claim messages and acknowledge sent, retry, or permanent failure.</p>'
      +'<p style="margin:10px 0"><button type="button" class="primary" id="mkemailsub">+ email subscription</button></p>'
      +(subs.length?'<table class="list"><tr><th>name</th><th>recipients</th><th>events</th><th></th></tr>'
        +subs.map(s=>'<tr'+(s.active?'':' style="opacity:.5"')+'><td>'+esc(s.name)+'</td><td>'+esc((s.recipients||[]).join(', '))+'</td><td>'+esc(eventFilterLabel(s))+'</td>'
          +'<td>'+(s.active?'<button type="button" data-esrevoke="'+esc(s.id)+'">revoke</button>':'revoked')+'</td></tr>').join('')+'</table>'
        :'<div class="empty">no email subscriptions yet</div>')
      +'<h4 style="margin-top:18px">recent outbox</h4>'
      +(outbox.length?'<table class="list"><tr><th>event</th><th>status</th><th>attempts</th><th>bridge</th><th>created</th></tr>'
        +outbox.map(m=>'<tr><td>'+esc(m.event)+'</td><td>'+esc(m.status)+(m.error?'<br><span class="err">'+esc(m.error)+'</span>':'')+'</td><td>'+esc(m.attempts)+'</td><td>'+esc(m.leasedBy||'')+'</td><td class="mono">'+esc((m.created||'').replace('T',' ').slice(0,16))+'</td></tr>').join('')+'</table>'
        :'<div class="empty">no queued email yet</div>')
      +'<p style="margin-top:10px"><button type="button" data-emailhistory>view outbox history</button></p>'
      +'<p class="setting-note" style="margin-top:12px">Botflow stores no SMTP password and performs no provider-specific signature verification. The bridge owns provider authentication, SPF/DKIM, suppression handling, and final delivery; botflow owns constrained ingress, dedupe, event selection, leases, retries, and audit state.</p>';

    $('#mkwebhook').onclick=()=>formModal('New webhook',[
      {name:'name',label:'name',required:true,value:'Webhook'},
      {name:'url',label:'HTTPS endpoint',type:'url',required:true},
      {name:'allow',label:'only these events (comma separated; empty means all)'},
      {name:'deny',label:'never these events (comma separated)'},
    ],'create',async d=>{
      const list=v=>v?v.split(',').map(x=>x.trim()).filter(Boolean):[];
      const r=await api('/api/projects/'+SEL+'/webhooks',{method:'POST',body:JSON.stringify({name:d.name,url:d.url,allowEvents:list(d.allow),denyEvents:list(d.deny)})});
      INTEGRATION_NOTICE={title:'Webhook signing secret',value:r.secret,note:'Copy this secret now. It is not shown again in this screen; protected company exports include it for restore. Rotating it invalidates the old secret.'};
      await refreshIntegrations();
    });
    $('#mkemailroute').onclick=()=>formModal('New inbound email route',[
      {name:'name',label:'name',required:true,value:'Email to board'},
      {name:'kind',label:'operation',type:'select',options:[{value:'create',label:'create a card'},{value:'comment',label:'comment on one card'}]},
      {name:'lane',label:'lane or substate for new cards (optional)'},
      {name:'card',label:'card id for comments (required for comment)'},
    ],'create',async d=>{
      const r=await api('/api/projects/'+SEL+'/email/routes',{method:'POST',body:JSON.stringify({name:d.name,kind:d.kind,lane:d.lane||undefined,card:d.card||undefined})});
      const endpoint=location.origin+'/api/email/inbound/'+SEL+'/'+r.token;
      INTEGRATION_NOTICE={title:'Inbound bridge endpoint',value:endpoint,note:'Copy this endpoint now. The token is stored only as a hash and cannot be shown again.'};
      await refreshIntegrations();
    });
    $('#mkemailsub').onclick=()=>formModal('New email subscription',[
      {name:'name',label:'name',required:true,value:'Email notifications'},
      {name:'recipients',label:'recipient addresses (comma separated)',required:true},
      {name:'allow',label:'only these events (comma separated; empty means all)'},
      {name:'deny',label:'never these events (comma separated)'},
    ],'create',async d=>{
      const list=v=>v?v.split(',').map(x=>x.trim()).filter(Boolean):[];
      await api('/api/projects/'+SEL+'/email/subscriptions',{method:'POST',body:JSON.stringify({name:d.name,recipients:list(d.recipients),allowEvents:list(d.allow),denyEvents:list(d.deny)})});
      await refreshIntegrations();
    });
    host.onclick=async e=>{
      const copy=e.target.closest('[data-copyintegration]');
      if(copy){try{await navigator.clipboard.writeText(copy.dataset.copyintegration);copy.textContent='copied'}catch{copy.textContent='copy failed'}return}
      if(e.target.closest('[data-dismissintegration]')){INTEGRATION_NOTICE=null;refreshIntegrations();return}
      const history=e.target.closest('[data-whdeliveries]');
      if(history){const hook=hooks.find(h=>h.id===history.dataset.whdeliveries);if(hook)webhookDeliveriesModal(hook);return}
      if(e.target.closest('[data-emailhistory]')){emailOutboxModal();return}
      const rotate=e.target.closest('[data-whrotate]');
      if(rotate){confirmModal('Rotate webhook secret','The old signing secret stops working immediately. Pending deliveries use the new secret.','rotate',async()=>{
        const r=await api('/api/projects/'+SEL+'/webhooks/'+encodeURIComponent(rotate.dataset.whrotate)+'/rotate',{method:'POST',body:'{}'});
        INTEGRATION_NOTICE={title:'New webhook signing secret',value:r.secret,note:'Copy this secret now. It is not shown again in this screen; protected company exports include it for restore.'};await refreshIntegrations()});return}
      const revoke=e.target.closest('[data-whrevoke]');
      if(revoke){confirmModal('Revoke webhook','Queued deliveries are cancelled and the endpoint stops receiving events. History remains visible.','revoke',async()=>{
        await api('/api/projects/'+SEL+'/webhooks/'+encodeURIComponent(revoke.dataset.whrevoke),{method:'DELETE'});await refreshIntegrations()});return}
      const route=e.target.closest('[data-errevoke]');
      if(route){confirmModal('Revoke inbound route','The secret endpoint stops accepting email immediately.','revoke',async()=>{
        await api('/api/projects/'+SEL+'/email/routes/'+encodeURIComponent(route.dataset.errevoke),{method:'DELETE'});await refreshIntegrations()});return}
      const sub=e.target.closest('[data-esrevoke]');
      if(sub){confirmModal('Revoke email subscription','Queued messages are cancelled. Sent history remains visible.','revoke',async()=>{
        await api('/api/projects/'+SEL+'/email/subscriptions/'+encodeURIComponent(sub.dataset.esrevoke),{method:'DELETE'});await refreshIntegrations()});return}
    };
  }catch(err){if(host.isConnected)host.innerHTML='<div class="err">'+esc(err.message)+'</div>'}
}
async function refreshSharing(){
  try{
    const shares=await api('/api/projects/'+SEL+'/shares');
    const live=shares.filter(s=>!s.revoked);
    $('#view').innerHTML='<p style="margin-bottom:10px"><button class="primary" id="mksh">+ share link</button>'
      +' <span style="color:var(--muted);font-size:12px">read-only public url. share the whole board, or scope it to a single card from the card itself.</span></p>'
      +(shares.length?'<table class="list"><tr><th>label</th><th>scope</th><th>url</th><th>created</th><th></th></tr>'
        +shares.map(s=>'<tr'+(s.revoked?' style="opacity:.5"':'')+'><td>'+esc(s.label)+'</td>'
          +'<td class="mono">'+(s.cardId?'card '+esc(s.cardId):'board')+'</td>'
          +'<td class="mono">'+(s.revoked?'revoked':'<a href="/s/'+esc(s.token)+'" target="_blank" style="color:var(--acc)">/s/'+esc(s.token.slice(0,10))+'…</a> <button class="ghost" data-copy="'+esc(s.token)+'">copy</button>')+'</td>'
          +'<td class="mono">'+esc(s.created.slice(0,10))+'</td>'
          +'<td><button data-ds="'+esc(s.id)+'">delete</button></td></tr>').join('')+'</table>'
        :'<div class="empty">no share links yet</div>')
      +(live.length?'<p style="color:var(--muted);font-size:12px;margin-top:10px">Direct links are live now. Listing board links on the login page is an explicit setting; card links never appear there.</p>':'');
    $('#mksh').onclick=()=>formModal('New share link',[
      {name:'label',label:'label (for your own bookkeeping)',required:true},
      {name:'card',label:'card id (optional: scopes the link to that one card)'},
    ],'create',async d=>{
      const r=await api('/api/projects/'+SEL+'/shares',{method:'POST',body:JSON.stringify({label:d.label,card:d.card||undefined})});
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
const AUDIT_PAGE_SIZE=25;
function renderAudit(host){
  const pages=[];
  let pageIndex=-1;
  let loading=false;
  let failure='';
  const paint=()=>{
    if(!host.isConnected)return;
    const page=pages[pageIndex];
    if(!page){
      host.innerHTML=loading?'loading…':failure?'<div class="err">'+esc(failure)+'</div>':'<div class="empty">no company activity yet</div>';
      return;
    }
    const table=page.items.length?'<table class="list"><tr><th>when</th><th>actor</th><th>action</th><th>detail</th></tr>'
      +page.items.map(a=>'<tr><td class="mono">'+esc((a.ts||'').replace('T',' ').slice(0,16))+'</td><td>'+esc(a.actor)+'</td><td>'+esc(a.action)+'</td><td>'+esc(a.detail)+'</td></tr>').join('')+'</table>'
      :'<div class="empty">no company activity yet</div>';
    const hasNewer=pageIndex>0;
    const hasOlder=pageIndex+1<pages.length||page.hasMore;
    const pager=hasNewer||hasOlder
      ?'<nav aria-label="Company activity pages" style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px">'
        +'<button type="button" data-audit-prev'+(hasNewer&&!loading?'':' disabled')+'>← newer</button>'
        +'<span class="setting-note" style="margin:0">page '+(pageIndex+1)+' · '+AUDIT_PAGE_SIZE+' per page</span>'
        +'<button type="button" data-audit-next'+(hasOlder&&!loading?'':' disabled')+'>'+(loading?'loading…':'older →')+'</button></nav>'
      :'';
    host.innerHTML=table+pager+(failure?'<div class="err">'+esc(failure)+'</div>':'');
    const previous=host.querySelector('[data-audit-prev]');
    if(previous)previous.onclick=()=>{pageIndex--;failure='';paint()};
    const next=host.querySelector('[data-audit-next]');
    if(next)next.onclick=()=>{
      if(pageIndex+1<pages.length){pageIndex++;failure='';paint();return}
      const last=page.items[page.items.length-1];
      if(last)load(last.seq);
    };
  };
  const load=async before=>{
    if(loading)return;
    loading=true;failure='';paint();
    try{
      const cursor=before==null?'':'&before='+encodeURIComponent(before);
      const list=await api('/api/org/activity?limit='+(AUDIT_PAGE_SIZE+1)+cursor);
      if(!host.isConnected)return;
      if(!Array.isArray(list))throw new Error('Invalid company activity response.');
      pages.splice(pageIndex+1);
      pages.push({items:list.slice(0,AUDIT_PAGE_SIZE),hasMore:list.length>AUDIT_PAGE_SIZE});
      pageIndex++;
    }catch(err){failure=err.message}
    finally{loading=false;if(host.isConnected)paint()}
  };
  load(null);
}
function stylePreview(st){
  const mode=THEME.mode==='system'?(mq.matches?'dark':'light'):THEME.mode;
  const p=st[mode];
  let a=st.accents[0][mode];
  if(st.id===THEME.style){
    if(THEME.accent==='custom'&&THEME.custom)a={acc:THEME.custom,accInk:contrastInk(THEME.custom)};
    else{const chosen=st.accents.find(x=>x.id===THEME.accent);if(chosen)a=chosen[mode]}
  }
  return '<div class="prev pv-'+st.id+'" aria-hidden="true" style="--pv-page:'+p.page+';--pv-surface:'+p.surface+';--pv-surface2:'+p.surface2+';--pv-grid:'+p.grid+';--pv-ink:'+p.ink+';--pv-acc:'+a.acc+'">'
    +'<div class="pvbar"><i></i><span></span><b></b></div><div class="pvbody"><div class="pvside"><i></i><i></i><i></i></div>'
    +'<div class="pvdeck"><i class="pvcard"></i><i class="pvcard"></i><i class="pvcard"></i></div></div></div>';
}
function themeControlsHtml(){
  const st=THEMES.find(s=>s.id===THEME.style)||THEMES[0];
  return '<h4 class="setting-title" style="margin-top:22px">visual world</h4><p class="setting-note">Five complete directions. Pick the character first, then tune its color and rhythm.</p>'
    +'<div class="stiles">'+THEMES.map(s=>'<button type="button" class="stile '+(s.id===THEME.style?'on':'')+'" data-style="'+s.id+'" aria-pressed="'+(s.id===THEME.style)+'">'+stylePreview(s)+'<b>'+esc(s.name)+'</b><div class="blurb">'+esc(s.blurb)+'</div></button>').join('')+'</div>'
    +'<h4 class="setting-title">accent</h4><p class="setting-note">Each set is tuned for this world in both light and dark mode.</p>'
    +'<div class="accents">'+st.accents.map(a=>{const mode=THEME.mode==='system'?(mq.matches?'dark':'light'):THEME.mode;
      return '<button type="button" class="accpill '+(a.id===THEME.accent?'on':'')+'" data-accent="'+a.id+'" aria-pressed="'+(a.id===THEME.accent)+'"><span class="sw" style="background:'+a[mode].acc+'"></span>'+esc(a.name)+'</button>'}).join('')
    +'<label class="accpill '+(THEME.accent==='custom'?'on':'')+'" id="custpill"><input type="color" id="custcol" value="'+(THEME.custom||'#7354c4')+'" aria-label="custom accent color">pick your own</label></div>'
    +'<div class="setting-pair"><div class="setting-group"><h4 class="setting-title">density</h4><p class="setting-note">A designed version of this world, not browser zoom.</p>'
    +'<div class="segsel">'+[['compact','more cards'],['relaxed','more breathing room']].map(x=>'<button type="button" data-density="'+x[0]+'" class="'+(x[0]===THEME.density?'primary':'')+'"><span>'+x[0]+'</span><small>'+x[1]+'</small></button>').join('')+'</div></div>'
    +'<div class="setting-group"><h4 class="setting-title">mode</h4><p class="setting-note">System follows each viewer’s device.</p>'
    +'<div class="segsel">'+[['system','follow device'],['light','daylight'],['dark','lights out']].map(x=>'<button type="button" data-mode="'+x[0]+'" class="'+(x[0]===THEME.mode?'primary':'')+'"><span>'+x[0]+'</span><small>'+x[1]+'</small></button>').join('')+'</div></div>'
    +'<div class="setting-group"><h4 class="setting-title">card tags</h4><p class="setting-note">How many tags each card shows before +N more.</p>'
    +'<label class="limitctl"><input type="number" id="cardtaglimit" min="0" max="${MAX_CARD_TAG_LIMIT}" step="1" value="'+THEME.cardTagLimit+'"><span>visible tags</span></label></div></div>'
    +'<p class="setting-note">Saved company-wide. Operators and public share pages use the same visual system, density, and card tag limit.</p>';
}
const SH='<h4 style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:22px">';
async function renderCompanyShares(host){
  try{
    const list=await api('/api/org/shares');if(!host.isConnected)return;
    host.innerHTML=list.length?'<table class="list"><tr><th>project</th><th>kind</th><th>member / scope</th><th>label</th><th>url</th><th>created</th><th></th></tr>'
      +list.map(s=>{const feed=s.kind==='feed';const scope=s.cardId?'card '+s.cardId:s.laneId?'lane '+s.laneId:s.filterId?'filter '+s.filterId:'board';const href=feed?'/feeds/'+s.token+'.rss':'/s/'+s.token;
        return '<tr'+(s.revoked?' style="opacity:.5"':'')+'><td>'+esc(s.projectName)+'</td><td>'+esc(s.kind)+'</td><td>'+esc((feed?(s.memberUsername||'removed member')+' · ':'')+scope)+'</td><td>'+esc(s.label)+'</td>'
        +'<td class="mono"><a href="'+esc(href)+'" target="_blank" style="color:var(--acc)">'+esc(href.slice(0,18))+'…</a></td>'
        +'<td class="mono">'+esc(s.created.slice(0,10))+'</td><td><button data-delsh="'+esc(s.id)+'">delete</button></td></tr>';}).join('')+'</table>'
      :'<div class="empty">no capabilities</div>';
  }catch(err){if(host.isConnected)host.innerHTML='<div class="err">'+esc(err.message)+'</div>'}
}
function renderSettings(main){
  // Everyone gets their own account. Everything below it reshapes the company,
  // so a non-owner simply stops here.
  const account=SH+'my account</h4><div id="maccount">loading…</div>';
  if(!IS_OWNER){
    main.innerHTML='<div class="phead"><h2>settings</h2></div><div class="view settings">'+account+'<div class="err" id="serr"></div></div>';
    renderAccount($('#maccount'));
    return;
  }
  main.innerHTML='<div class="phead"><h2>settings</h2></div><div class="view settings">'
    +account
    +SH+'company</h4>'
    +'<div style="display:flex;gap:8px;align-items:center;max-width:420px">'
    +'<input id="orgname" value="'+esc(ORG.name)+'" aria-label="company name" style="flex:1">'
    +'<button id="orgsave">rename</button></div>'
    +'<p class="setting-note">Shown at the top of every board and on the login page.</p>'
    +SH+'members</h4><div id="mmembers" style="max-width:900px">loading…</div>'
    +'<section id="themecontrols">'+themeControlsHtml()+'</section>'
    +'<h4 style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:22px">login page</h4>'
    +'<label style="font-size:13px;display:flex;gap:8px;align-items:center"><input type="checkbox" id="gs"> list public board links on the login page</label>'
    +'<h4 style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:22px">company data</h4>'
    +'<div style="display:flex;gap:8px;flex-wrap:wrap"><button id="orgexp">download company export</button>'
    +'<button id="demoload">load the Scoops Empire demo</button></div>'
    +'<p style="color:var(--muted);font-size:12px;margin-top:6px">The export is restore-grade JSON: every space, project, board, card, member (password hashes included), api key hash, public share, private feed capability, and active webhook/email configuration (including signing secrets and route token hashes). Store it like a credential: it is one. A restore resets webhook delivery history and health plus email queues, history, leases, and dedupe records; old frozen events are never replayed under remapped project ids. Uploaded files are NOT inside it: they live in the R2 bucket (the export lists their keys), so back the bucket up separately before any deletion. File urls are permanent bearer links: anyone holding one can fetch that file, and revoking a share does not revoke it. The demo adds a sample ice cream company as a new space.</p>'
    +'<h4 style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:22px">manage: spaces and projects</h4>'
    +'<div id="mtree" style="max-width:560px"></div>'
    +'<h4 style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:22px">manage: capabilities</h4>'
    +'<div id="mshares" style="max-width:900px">loading…</div>'
    +'<h4 style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:22px">company activity</h4>'
    +'<div id="maudit" style="max-width:720px">loading…</div>'
    +'<div class="err" id="serr"></div></div>';
  renderAudit($('#maudit'));
  const countTree=n=>1+n.children.reduce((a,c)=>a+countTree(c),0);
  const mrowProj=n=>'<div class="mrow">'+esc(n.name)+'<span class="who">'+esc(n.id)+'</span>'
    +'<button data-delproj="'+esc(n.id)+'" data-name="'+esc(n.name)+'" data-count="'+countTree(n)+'">delete</button></div>'
    +(n.children.length?'<div class="mkids">'+n.children.map(mrowProj).join('')+'</div>':'');
  $('#mtree').innerHTML=ORG.spaces.length?ORG.spaces.map(s=>
    '<div class="mrow" style="font-weight:600">'+esc(s.name)+'<span class="who">'+esc(s.id)+'</span>'
    +'<button data-delspace="'+esc(s.id)+'" data-name="'+esc(s.name)+'" data-count="'+s.projects.reduce((a,p)=>a+countTree(p),0)+'">delete space</button></div>'
    +(s.projects.length?'<div class="mkids">'+s.projects.map(mrowProj).join('')+'</div>':'')).join('')
    :'<div class="empty">no spaces yet</div>';
  renderCompanyShares($('#mshares'));
  const save=async next=>{
    try{const saved=await api('/api/settings',{method:'POST',body:JSON.stringify(next)});applyTheme(saved);const controls=$('#themecontrols');if(controls&&VIEW==='settings'){patchView(controls,themeControlsHtml());wireCustomAccent()}}
    catch(err){const out=$('#serr');if(out)out.textContent=err.message}
  };
  const wireCustomAccent=()=>{const custom=$('#custcol');if(custom){custom.oninput=e=>applyTheme({...THEME,accent:'custom',custom:e.target.value});custom.onchange=e=>save({...THEME,accent:'custom',custom:e.target.value})}
    const limit=$('#cardtaglimit');if(limit)limit.onchange=e=>save({...THEME,cardTagLimit:Number(e.target.value)})};
  api('/api/settings').then(cur=>{const gs=$('#gs');if(gs){gs.checked=cur.gateShares!==false;
    gs.onchange=()=>api('/api/settings',{method:'POST',body:JSON.stringify({...THEME,gateShares:gs.checked})}).catch(err=>{$('#serr').textContent=err.message})}});
  renderAccount($('#maccount'));
  renderMembers($('#mmembers'));
  $('#orgsave').onclick=async()=>{
    try{
      const r=await api('/api/org/name',{method:'POST',body:JSON.stringify({name:$('#orgname').value})});
      ORG.name=r.name;renderHeader();
      $('#serr').textContent='';toast('Company renamed to '+r.name+'.');
    }catch(err){$('#serr').textContent=err.message}
  };
  $('#orgexp').onclick=async()=>{
    try{const data=await api('/api/org/export');
      const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='botflow-company-export.json';a.click();URL.revokeObjectURL(a.href);
    }catch(err){$('#serr').textContent=err.message}};
  $('#demoload').onclick=async()=>{
    const b=$('#demoload');b.disabled=true;b.textContent='loading demo…';
    try{await api('/api/demo',{method:'POST'});await start()}catch(err){$('#serr').textContent=err.message;b.disabled=false;b.textContent='load the Scoops Empire demo'}};
  wireCustomAccent();
  main.querySelector('.settings').onclick=async e=>{
    // closest() can walk beyond the element whose click we handle. <html>
    // carries theme data attributes too, so bound every delegated lookup to
    // this settings panel before deciding that a control was clicked.
    const panel=e.currentTarget;
    const within=selector=>{const node=e.target.closest(selector);return node&&panel.contains(node)?node:null};
    const dp=within('[data-delproj]');
    if(dp){const n=dp.dataset.name,c=Number(dp.dataset.count);
      confirmModal('Delete project',"Permanently deletes '"+esc(n)+"'"+(c>1?' and its '+(c-1)+' nested project(s)':'')
        +': boards, cards, keys, share links, and uploaded files. No undo, and uploads are not inside the JSON export: back the bucket up separately if they matter.',
        'delete forever',async()=>{await api('/api/projects/'+dp.dataset.delproj,{method:'DELETE'});await start()});return}
    const dsp=within('[data-delspace]');
    if(dsp){const n=dsp.dataset.name,c=Number(dsp.dataset.count);
      confirmModal('Delete space',"Permanently deletes the space '"+esc(n)+"' and all "+c+" project(s) inside it: boards, cards, keys, share links, and uploaded files. No undo, and uploads are not inside the JSON export: back the bucket up separately if they matter.",
        'delete forever',async()=>{await api('/api/spaces/'+dsp.dataset.delspace,{method:'DELETE'});await start()});return}
    const dsh=within('[data-delsh]');
    if(dsh){await api('/api/shares/'+dsh.dataset.delsh,{method:'DELETE'});await renderCompanyShares($('#mshares'));return}
    if(within('#custpill'))return; // the color input handles itself
    const tile=within('.stile[data-style]');
    const pill=within('[data-accent]');
    const mode=within('[data-mode]');
    const density=within('[data-density]');
    if(!tile&&!pill&&!mode&&!density)return;
    const next={...THEME};
    if(tile){next.style=tile.dataset.style;const ns=THEMES.find(s=>s.id===next.style);
      if(next.accent!=='custom'&&!ns.accents.some(a=>a.id===next.accent))next.accent=ns.accents[0].id}
    if(pill)next.accent=pill.dataset.accent;
    if(mode)next.mode=mode.dataset.mode;
    if(density)next.density=density.dataset.density;
    save(next);
  };
}
applyTheme(THEME);
if(PUB)publicStart();else start();
`;

export function uiHtml(pub: string | null, pubCard: string | null = null): string {
  // JSON inside <script>: escape "<" so an attacker-controlled card id cannot
  // close the tag early and inject markup (same trick as the CLI viewer).
  const safeJson = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#edf5f5">
<title>botflow manager</title>
<style>${CSS}</style>
</head>
<body>
<script>window.__THEMES__=${safeJson(STYLES)};window.__PUB__=${safeJson(pub)};window.__PUBCARD__=${safeJson(pubCard)};</script>
<script>${JS}</script>
</body>
</html>`;
}
