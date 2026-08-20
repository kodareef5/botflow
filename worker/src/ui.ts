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
.cols{display:flex;gap:var(--col-gap);align-items:flex-start;position:relative}
.relsvg{position:absolute;inset:0;overflow:visible;pointer-events:none;z-index:4}
.relsvg path{fill:none;stroke:var(--st-blocked);stroke-width:2;opacity:.58;vector-effect:non-scaling-stroke}
.relsvg path.resolved{stroke:var(--muted);stroke-dasharray:4 4;opacity:.4}
.card{position:relative;z-index:5}
.col{background:var(--surface);border:var(--bw) var(--bs) var(--grid);border-radius:var(--rc);min-width:var(--col-w);width:var(--col-w);flex:none;padding:var(--col-pad);box-shadow:var(--shadow)}
.col h3{font:700 11px/1.25 var(--display);text-transform:uppercase;letter-spacing:.04em;color:var(--ink2);padding:2px 4px 7px;display:flex;gap:6px}
.col h3 .n{color:var(--muted);font-weight:400}
.col h3 .wipbad{color:var(--st-blocked)}
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
.badges .ok{color:var(--st-done)}
.badges .due-overdue,.badges .due-today{color:var(--st-blocked);font-weight:650}
.badges .due-soon{color:#c47317;font-weight:650}
.badges .lbl{box-shadow:inset 3px 0 0 var(--lc)}
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
.setting-pair{display:grid;grid-template-columns:repeat(2,minmax(220px,1fr));gap:24px;max-width:760px;margin:5px 0 20px}
.setting-group{min-width:0}
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
let THEME={style:'harbor',accent:'pacific',mode:'system',density:'relaxed',custom:null};
let ORG=null,SEL=null,VIEW='board',BOARD=null,timer=null,MODAL=null,UPLOADS=false;
// Role gates, refreshed from /api/org on every boot. RO stays the read-only
// flag for public share pages; these are about who is logged in.
let ME=null,CAN_WRITE=false,IS_OWNER=false,DIR=new Map();
// Search state lives outside the board DOM. Polling only morphs #view, so a
// focused query input is never replaced while someone is typing.
let SEARCH_PROJECT=null,SEARCH_QUERY='',SEARCH_SAVED='',SEARCH_IDS=null,SEARCH_TIMER=null,SEARCH_SEQ=0;
let NEW_FEED=null;
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
  const modeChoice=t.mode==='light'||t.mode==='dark'?t.mode:'system';
  const mode=modeChoice==='system'?(mq.matches?'dark':'light'):modeChoice;
  const p=st[mode],d=st.densities[density];
  let a,accent;
  if(t.accent==='custom'&&t.custom){accent='custom';a={acc:t.custom,accInk:contrastInk(t.custom)}}
  else{const found=st.accents.find(x=>x.id===t.accent)||st.accents[0];accent=found.id;a=found[mode]}
  THEME={style:st.id,accent,mode:modeChoice,density,custom:t.custom||null};
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
function overlay(html,cls,label){
  closeOverlay();
  const opener=document.activeElement;
  const o=document.createElement('div');o.className='overlay';
  o.innerHTML='<div class="modal '+(cls||'')+'" role="dialog" aria-modal="true" tabindex="-1"'+(label?' aria-label="'+esc(label)+'"':'')+'>'+html+'</div>';
  o.addEventListener('mousedown',e=>{if(e.target===o)closeOverlay()});
  o.addEventListener('keydown',e=>{
    if(e.key!=='Tab')return;
    const f=[...o.querySelectorAll('button,[href],input,textarea,select,[tabindex]:not([tabindex="-1"])')]
      .filter(x=>!x.disabled&&x.offsetParent!==null);
    if(!f.length)return;
    const first=f[0],last=f[f.length-1];
    if(e.shiftKey&&document.activeElement===first){last.focus();e.preventDefault()}
    else if(!e.shiftKey&&(document.activeElement===last||!o.contains(document.activeElement))){first.focus();e.preventDefault()}
  });
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
      ?'<textarea name="'+f.name+'" rows="'+(f.rows||6)+'" placeholder="'+esc(f.placeholder||'')+'" '+(f.required?'required':'')+'>'+esc(f.value||'')+'</textarea>'
      :f.type==='select'
        ?'<select name="'+f.name+'">'+(f.options||[]).map(o=>'<option value="'+esc(o.value)+'"'+(String(f.value??'')===String(o.value)?' selected':'')+'>'+esc(o.label)+'</option>').join('')+'</select>'
        :'<input name="'+f.name+'" type="'+(f.type==='password'?'password':f.type==='number'?'number':f.type==='url'?'url':'text')+'"'+(f.type==='password'?' autocomplete="new-password"':'')+' value="'+esc(f.value||'')+'" placeholder="'+esc(f.placeholder||'')+'" '+(f.required?'required':'')+'>')
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
  if(SEL&&SEL!=='::settings'&&!findAny(SEL))SEL=null;
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
  CAN_WRITE=!!ME&&ME.role!=='read';
  IS_OWNER=!!ME&&ME.role==='owner';
  RO=!!PUB||!CAN_WRITE;
  DIR=new Map((org.directory||[]).map(m=>[m.username,m]));
}
// Awaits the board too: callers that await this expect the deck to be current
// when it resolves, or anything touching the re-rendered DOM afterwards (like
// putting keyboard focus back on a card that just moved) acts on the old one.
async function reloadOrg(){adoptOrg(await api('/api/org'));renderSide();renderHeader();if(VIEW==='board'&&BOARD){BOARD=null;await refreshBoard()}}
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
  $('#setbtn').onclick=()=>{SEL='::settings';renderSide();renderMain()};
  $('#burger').onclick=()=>$('#side').classList.toggle('open');
  renderHeader();renderSide();renderMain();
  timer=setInterval(()=>{if(VIEW==='board'&&SEL&&SEL!=='::settings'&&!MODAL&&!DRAG&&!PRESS)refreshBoard(true)},3000);
}
function projRow(n){
  const a=n.aggregate;
  return '<div class="row '+(n.id===SEL?'sel':'')+'" data-proj="'+n.id+'" tabindex="0" role="button" aria-label="'+esc(n.name)+'">'
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
    +'<div class="sidefoot"><div class="row '+(SEL==='::settings'?'sel':'')+'" id="setrow" tabindex="0" role="button">'+IC.gear+' settings</div></div>';
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
  if(SEL==='::settings')return renderSettings(main);
  const p=SEL?findAny(SEL):null;
  if(!p){main.innerHTML='<div class="view"><div class="empty">'
    +(IS_OWNER?'Create a space and a project to begin. Bots connect with their own credentials via the REST API or <code>botflow push</code>.'
      :'Nothing here yet. An owner has to give you a space or a project before there is a board to work.')
    +'</div></div>';return}
  if(SEARCH_PROJECT!==SEL){
    if(SEARCH_TIMER)clearTimeout(SEARCH_TIMER);
    SEARCH_PROJECT=SEL;SEARCH_QUERY='';SEARCH_SAVED='';SEARCH_IDS=null;SEARCH_SEQ++;NEW_FEED=null;
  }
  // Feeds are personal member capabilities, while public sharing remains a
  // company-level decision. Every member can therefore reach feeds; only an
  // owner gets the public-sharing tab.
  const tabs=['board','activity','feeds'].concat(IS_OWNER?['sharing']:[]);
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
    +(CAN_WRITE?'<button id="newcard" class="ghost" title="add a card to this board">+ card</button>':'')
    +(CAN_WRITE?'<button id="quickcard" class="ghost" title="create several cards with quick-add syntax">+ quick</button><button id="bulkcard" class="ghost" title="move, close, or label several card ids">bulk</button>':'')
    +(IS_OWNER?'<button id="editboard" class="ghost" title="edit lanes, substates, wip, rollup">✎ edit board</button>':'')
    +'<div class="tabs" role="tablist">'+tabs.map(t=>
      '<button data-tab="'+t+'" role="tab" aria-selected="'+(VIEW===t)+'" class="'+(VIEW===t?'on':'')+'">'+t+'</button>').join('')+'</div></div>'
    +'<div class="view" id="view">loading…</div>';
  main.querySelector('.tabs').onclick=e=>{const b=e.target.closest('[data-tab]');if(b){VIEW=b.dataset.tab;renderMain()}};
  const eb=$('#editboard');if(eb)eb.onclick=boardEditor;
  const nc=$('#newcard');if(nc)nc.onclick=()=>newCard();
  const qc=$('#quickcard');if(qc)qc.onclick=quickCards;
  const bc=$('#bulkcard');if(bc)bc.onclick=bulkCardsUi;
  if(VIEW==='board'){wireSearchControls();refreshBoard()}
  else if(VIEW==='activity')refreshActivity();
  else if(VIEW==='feeds')refreshFeeds();
  else refreshSharing();
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
  requestAnimationFrame(()=>drawRelations(BOARD));
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
  const fields=(templates.length?[{name:'template',label:'template (optional)',type:'select',options:[{value:'',label:'none'}].concat(templates.map(t=>({value:t.id,label:t.name})))}]:[]).concat([
    {name:'title',label:'title',required:true},
    {name:'priority',label:'priority (p0-p3, optional)'},
    {name:'labels',label:'labels (comma separated, optional)'},
    {name:'assignee',label:'accountable assignee (username, optional)'},
    {name:'delegate',label:'executing delegate (bot username, optional)'},
    {name:'start',label:'start (YYYY-MM-DD or UTC datetime)'},
    {name:'due',label:'due (YYYY-MM-DD or UTC datetime)'},
    {name:'estimate',label:'estimate (positive points)',type:'number'},
    {name:'evergreen',label:'aging signal',type:'select',options:[{value:'',label:'normal'},{value:'true',label:'evergreen (hide aging)'}]},
    {name:'cover_color',label:'cover color (#RGB or #RRGGBB)'},
  ]).concat(customFormFields(defs,[]));
  formModal('New card',fields,'create',async d=>{
    const labels=d.labels?d.labels.split(',').map(x=>x.trim()).filter(Boolean):undefined;
    const r=await api('/api/projects/'+SEL+'/cards',{method:'POST',body:JSON.stringify({
      title:d.title,template:d.template||undefined,lane:lane||undefined,priority:d.priority||undefined,labels:labels,
      assignee:d.assignee||undefined,delegate:d.delegate||undefined,start:d.start||undefined,due:d.due||undefined,
      estimate:d.estimate?Number(d.estimate):undefined,evergreen:d.evergreen===''?undefined:d.evergreen==='true',
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
    {name:'add',label:'labels to add (comma separated)'},
    {name:'remove',label:'labels to remove (comma separated)'},
  ],'apply',async d=>{
    const split=v=>v?v.split(',').map(x=>x.trim()).filter(Boolean):undefined;
    const action={kind:d.kind,to:d.to||undefined,reason:d.reason||undefined,add:split(d.add),remove:split(d.remove)};
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
function coverOf(c){
  if(c.cover)return c.cover;
  if(!c.coverAuto)return null;
  const p=(c.previews||[])[0];
  return p?p.image:null;
}
function badge(ic,txt,cls){return '<span class="'+(cls||'')+'">'+ic+(txt!==undefined?' '+txt:'')+'</span>'}
function fieldText(v){return Array.isArray(v)?v.join(', '):v===true?'yes':v===false?'no':String(v)}
function labelBadge(l){
  return '<span class="lbl" style="--lc:'+esc(l.color||'var(--grid)')+'" title="'+esc(l.group?l.group+': '+l.value:l.id)+'">#'+esc(l.value||l.id)+'</span>';
}
function dueFace(c){
  const d=c.metrics&&c.metrics.due;if(!d||d.status==='complete')return null;
  const text=d.status==='overdue'?Math.abs(d.days)+'d late':d.status==='today'?'due today':d.days+'d';
  return '<span class="due-'+d.status+'" title="due '+esc(c.due)+'">◷ '+text+'</span>';
}
function faceBadges(b,c){
  const ready=new Set(b.ready||[]),items=[];
  if(c.priority)items.push('<span class="'+(c.priority==='p0'?'p0':c.priority==='p1'?'p1':'')+'">'+esc(c.priority)+'</span>');
  if(c.blocked)items.push('<span class="blk" title="'+esc(c.blocked)+'">⛔ blocked</span>');
  const due=dueFace(c);if(due)items.push(due);
  if(c.assignee)items.push('<span title="accountable assignee">@'+esc(who(c.assignee))+'</span>');
  if(c.delegate)items.push('<span title="executing delegate">⇢ @'+esc(who(c.delegate))+'</span>');
  for(const l of c.labelDetails||[])items.push(labelBadge(l));
  if(!(c.labelDetails||[]).length)for(const l of c.labels||[])items.push('<span>#'+esc(l)+'</span>');
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
  return items.slice(0,10).join('');
}
function cardHtml(b,c){
  const board=c.type==='board';
  const age=c.metrics&&c.metrics.agingLevel||0;
  return '<div class="card '+(c.blocked?'blocked ':'')+(c.coverColor?'has-color ':'')+(age?'age-'+age:'')+'"'+(c.coverColor?' style="--cover-color:'+esc(c.coverColor)+'"':'')+' data-card="'+esc(c.id)+'" tabindex="0" role="button" aria-label="'+esc(c.id+' '+c.title)+'"'
    +(RO?'':' aria-keyshortcuts="Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown"')+'>'
    +((cov=>cov?'<img class="art" src="'+esc(cov)+'" alt="" loading="lazy">':'')(coverOf(c)))
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
  return '<div class="cols" style="margin-top:12px">'+b.lanes.map(lane=>{
    const cards=SEARCH_IDS===null?lane.cards:lane.cards.filter(c=>SEARCH_IDS.has(c.id));
    const n=cards.length;
    const wip=lane.wip!=null?'<span class="'+(n>lane.wip?'wipbad':'n')+'">'+n+'/'+lane.wip+'</span>':'<span class="n">'+n+'</span>';
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
    :r==='deps'?'This card is waiting on work that is not done yet.'
    :r==='not-ready'?'This card is not ready to be claimed: it sits in <b>'+esc(conflict.position||'')+'</b>.'
    :'This card cannot be claimed right now.';
  return '<p style="font-size:13px;color:var(--ink2);line-height:1.55">'+lead+'</p>'
    +(detail?'<p style="font-size:12px;color:var(--muted);margin-top:6px">'+esc(detail)+'</p>':'');
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
function dragStart(card,ev){
  if(RO||!BOARD)return;
  const c=(BOARD.lanes||[]).flatMap(l=>l.cards).find(x=>x.id===card.dataset.card);
  if(!c)return;
  const rect=card.getBoundingClientRect();
  const ghost=card.cloneNode(true);
  ghost.classList.add('dragghost');ghost.removeAttribute('id');
  ghost.style.width=rect.width+'px';
  document.body.appendChild(ghost);
  const hint=document.createElement('div');
  hint.className='draghint';
  hint.textContent=IS_OWNER?'drop to move · hold over a red zone to override · esc cancels':'drop to move · esc cancels';
  document.body.appendChild(hint);
  card.classList.add('dragging');
  document.body.classList.add('dragmode');
  DRAG={id:c.id,card:c,src:card,ghost:ghost,hint:hint,legal:dropRules(BOARD,c),over:null,force:false};
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
  const send=async f=>{
    await api('/api/projects/'+SEL+'/cards/'+id+'/move',{method:'POST',body:JSON.stringify(f?{to:to,force:true}:{to:to})});
    await reloadOrg();
  };
  if(force){
    // The lane's own rules forbid this. Say which rule, and make taking the
    // override a separate, deliberate act.
    return confirmModal('Override the lane rules',
      'Moving '+esc(id)+' to <b>'+esc(to)+'</b> breaks the order this lane declares. Forcing is recorded as an override in the activity log.',
      'force the move',()=>send(true));
  }
  try{await send(false)}
  catch(err){toast(err.message)}
}
function boardClicks(e){
  if(Date.now()-DRAG_ENDED<400)return;
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
  const el=e.target.closest('[data-card]');
  if(el)openCard(el.dataset.card);
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
  const send=async force=>{
    try{
      await api('/api/projects/'+SEL+'/cards/'+id+'/move',{method:'POST',body:JSON.stringify(force?{to:to,force:true}:{to:to})});
      await reloadOrg();
      // The card lives in another column now; put focus back on it so a run
      // of moves does not strand the keyboard at the old position.
      const again=document.querySelector('[data-card="'+id+'"]');
      if(again)again.focus();
      toast(id+' moved to '+to);
    }catch(err){toast(err.message)}
  };
  const legal=dropRules(BOARD,c).get(lane.id+'\u0000'+(sub||''))!==false;
  if(legal)return send(false);
  if(!IS_OWNER)return toast(lane.id+' is strict: '+id+' can only enter at '+lane.id+'.'+lane.substates[0]);
  confirmModal('Override the lane rules',
    'Moving '+esc(id)+' to <b>'+esc(to)+'</b> breaks the order this lane declares. Forcing is recorded as an override in the activity log.',
    'force the move',()=>send(true));
}
function boardKeys(e){
  const cur=e.target.closest('[data-card]');if(!cur)return;
  if(e.shiftKey&&e.key.startsWith('Arrow')){
    e.preventDefault();
    keyboardMove(cur,e.key.slice(5).toLowerCase());
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
function nodeKey(n){return n.nodeType===1?(n.dataset&&n.dataset.card?'card:'+n.dataset.card:n.id?'#'+n.id:null):null}
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
  return '<div id="bstats">'+chips(b.distribution)+(errs?'<div class="err">'+errs+' lint error(s)</div>':'')+'</div>'
    +'<div id="bcols">'+colsHtml(b)+wormholesHtml()+'</div>';
}
async function refreshBoard(quiet){
  let b;try{b=await api('/api/projects/'+SEL+'/board')}catch(err){if(!quiet)$('#view').innerHTML='<div class="err">'+esc(err.message)+'</div>';return}
  if(quiet&&JSON.stringify(b)===JSON.stringify(BOARD))return;
  BOARD=b;
  const pi=$('#pinfo');if(pi){pi.textContent=b.cards+' cards · '+pct(b.progress);pi.title='structural progress: every card is one unit; a sub-board fills its unit by its own fraction'}
  const v=$('#view');if(!v)return;
  syncSearchControls(b);
  patchView(v,boardHtml(b));
  v.onclick=boardClicks;
  v.onkeydown=boardKeys;
  v.onpointerdown=boardPointerDown;
  requestAnimationFrame(()=>drawRelations(b));
  if(SEARCH_QUERY.trim()||SEARCH_SAVED)runSearch();
}
function drawRelations(b){
  const cols=$('.cols');if(!cols)return;
  const old=$('.relsvg',cols);if(old)old.remove();
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
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.classList.add('relsvg');
  svg.setAttribute('width',String(cols.scrollWidth));svg.setAttribute('height',String(cols.scrollHeight));svg.setAttribute('aria-hidden','true');
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
  cols.prepend(svg);
}
window.addEventListener('resize',()=>{if(BOARD&&VIEW==='board')drawRelations(BOARD)});
// A press on a card is only a drag once it has proved itself: a mouse has to
// travel past the slop threshold, and a finger has to stay put long enough
// that it clearly is not a scroll. Until then the press is still a click.
function boardPointerDown(e){
  if(RO||e.button!==0)return;
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
window.addEventListener('pointerup',()=>{if(DRAG)dragDrop();else dragCleanup()});
window.addEventListener('pointercancel',dragCleanup);
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
  $('#addlane',m).onclick=()=>{$('#lanes',m).insertAdjacentHTML('beforeend',laneRow({id:'',canonical:'todo',substates:[],order:'free',wip:null}));$('#lanes',m).lastElementChild.querySelector('.lid').focus()};
  $('#addlabel',m).onclick=()=>{$('#labeldefs',m).insertAdjacentHTML('beforeend',labelRow({id:'',color:''}));$('#labeldefs',m).lastElementChild.querySelector('.rid').focus()};
  $('#addfield',m).onclick=()=>{$('#fielddefs',m).insertAdjacentHTML('beforeend',fieldRow({id:'',name:'',type:'text',options:[],face:false}));$('#fielddefs',m).lastElementChild.querySelector('.rid').focus()};
  $('#addtemplate',m).onclick=()=>{$('#templatedefs',m).insertAdjacentHTML('beforeend',templateRow({id:'',name:'',labels:[],fields:{},body:''}));$('#templatedefs',m).lastElementChild.querySelector('.tid').focus()};
  $('#labeldefs',m).onclick=e=>{const x=e.target.closest('[data-rmlabel]');if(x)x.closest('[data-labeldef]').remove()};
  $('#fielddefs',m).onclick=e=>{const x=e.target.closest('[data-rmfield]');if(x)x.closest('[data-fielddef]').remove()};
  $('#templatedefs',m).onclick=e=>{const x=e.target.closest('[data-rmtemplate]');if(x)x.closest('[data-template]').remove()};
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
    const lanes=[],labels=[],fields=[],templates=[],migrations={};
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
        order:row.querySelector('.lord').value,wip:wip===''?null:Number(wip)});
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
    try{
      await api('/api/projects/'+SEL+'/config',{method:'PUT',body:JSON.stringify({
        name:$('#bname',m).value,lanes,labels,fields,templates,
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
  try{b=await api('/api/public/'+PUB+'/board')}catch(err){return publicDead(err.message)}
  renderPublic(b);
  setInterval(async()=>{
    if(MODAL)return;
    try{const nb=await api('/api/public/'+PUB+'/board');if(JSON.stringify(nb)!==JSON.stringify(BOARD))renderPublic(nb)}catch{}
  },4000);
}
// A card-scoped link renders that one card as the whole page: same card
// anatomy as the modal, standing alone, read only, live.
let PUBTAB='card',PUBLAST='';
async function publicCardStart(){
  let c;
  try{c=await api('/api/public/'+PUB+'/cards/'+PUBCARD)}catch(err){return publicDead(err.message)}
  document.body.classList.add('pubcard');
  document.body.innerHTML='<header class="top"><h1 id="pctitle"></h1><span class="spacer"></span></header>'
    +'<div class="view" style="flex:1;overflow:auto"><div class="modal cardmodal" style="margin:0 auto" id="pcbox"></div></div>'
    +'<div class="pubfoot">a single card shared with botflow: git-native kanban for AI agents. <a href="/about">learn more</a></div>';
  renderPublicCard(c);
  setInterval(async()=>{
    try{const nc=await api('/api/public/'+PUB+'/cards/'+PUBCARD);
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
  box.querySelector('.tabbar').onclick=e=>{const b=e.target.closest('[data-ctab]');if(b){PUBTAB=b.dataset.ctab;renderPublicCard(c)}};
}
function renderPublic(b){
  const fresh=!BOARD;
  BOARD=b;
  document.title=b.name+' · botflow';
  if(fresh){
    document.body.innerHTML='<header class="top"><h1>'+esc(b.name)+' <span class="sub">shared board · read only</span></h1>'
      +'<div class="meter" id="hmeter" title="structural progress: every card is one unit; a sub-board fills its unit by its own fraction"></div><span id="hstrip"></span><span class="spacer"></span></header>'
      +'<div class="view" id="view" style="flex:1;overflow:auto"></div>'
      +'<div class="pubfoot">shared with botflow: git-native kanban for AI agents. <a href="/about">learn more</a></div>';
    $('#view').onclick=boardClicks;
    $('#view').onkeydown=boardKeys;
  }
  $('#hmeter').innerHTML='<div class="track"><div class="fill" style="width:'+Math.round((b.progress||0)*100)+'%"></div></div><b>'+pct(b.progress)+'</b>';
  $('#hstrip').innerHTML=strip(b.distribution);
  patchView($('#view'),boardHtml(b));
}
// ---- the card modal ----
async function openCard(cid,tab){
  let c;try{c=await api(cardApi(cid))}catch(err){return}
  MODAL=cid;
  const t=tab||'card';
  const m=overlay(cardModalHtml(c,t),'cardmodal',c.id+' '+c.title);
  wireCardModal(m,c,t);
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
  if(c.blocked)meta.push('<span class="badges"><span class="blk">⛔ '+esc(c.blocked)+'</span></span>');
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
    acts.push('<button class="ghost" data-watch data-on="'+watching+'" aria-pressed="'+watching+'" title="'+(watching?'stop watching':'watch this card')+'">'+(watching?'◉ watching':'○ watch')+'</button>');
    acts.push('<button class="ghost" data-vote data-on="'+voted+'" aria-pressed="'+voted+'" title="'+(voted?'withdraw your vote':'vote for this card')+'">▲ '+(voted?'voted':'vote')+'</button>');
    acts.push('<button class="ghost" data-boost title="leave a short boost">✦ boost</button>');
    meta.push(acts.join(''));
    meta.push('<button class="ghost" data-editcard title="edit card fields">✎ edit</button>'
      +'<button class="ghost" data-mergecard title="merge this duplicate into another card">merge duplicate</button>'
      +'<button class="ghost" data-transfercard title="copy or move this card to a nested board">⇢ handoff</button>'
      +'<button class="ghost" data-feedcard title="create a private activity feed for this card">☊ feed</button>'
      +'<button class="ghost" data-sharecard title="public read-only link to just this card">↗ share</button>');
  }
  const tabs=[['card','card'],['chat','chat '+((p.comments||[]).length||'')],['activity','activity']];
  return (c.coverColor?'<div class="coverband" style="--cover-color:'+esc(c.coverColor)+'"></div>':'')
    +((cov=>cov?'<img class="banner" src="'+esc(cov)+'" alt="">':'')(coverOf(c)))
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
    .concat((c.previews||[]).map(v=>({img:v.image,href:v.url,kind:'link'})));
  if(tiles.length){
    out+='<h4>gallery'+(RO?'':' <span class="h-act">'+(c.cover?'<button data-cover="none">hide art</button>':'<button data-cover="auto">auto art</button>')+'</span>')+'</h4><div class="gallery">'
      +tiles.map(t=>'<div class="shot">'
        +(linkOk(t.href)?'<a href="'+esc(t.href)+'" target="_blank" rel="noopener"><img src="'+esc(t.img)+'" alt="" loading="lazy"></a>':'<img src="'+esc(t.img)+'" alt="" loading="lazy">')
        +(t.kind==='link'?'<span class="src" title="'+esc(t.href)+'">'+esc(hostOf(t.href))+'</span>':'')
        +(RO?'':'<button class="setcov primary" data-cover="'+esc(t.img)+'">☆ cover</button>')+'</div>').join('')+'</div>';
  }
  const kv=[];
  if(c.assignee)kv.push('<span><b>assignee</b> '+esc(who(c.assignee))+'</span>');
  if(c.delegate)kv.push('<span><b>delegate</b> '+esc(who(c.delegate))+'</span>');
  if(c.start)kv.push('<span><b>start</b> '+esc(c.start)+'</span>');
  if(c.due)kv.push('<span><b>due</b> '+esc(c.due)+'</span>');
  if(c.estimate!=null)kv.push('<span><b>estimate</b> '+esc(c.estimate)+'</span>');
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
    const open=e.target.closest('[data-opencard]');
    if(open){const target=open.dataset.opencard;if(!target.includes('#'))openCard(target,'card');return}
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
    if(unlink){await api('/api/projects/'+SEL+'/cards/'+c.id+'/unlink',{method:'POST',body:JSON.stringify({target:unlink.dataset.unlinkcard,type:unlink.dataset.reltype})});openCard(c.id,'card');refreshBoard(true);return}
    if(e.target.closest('[data-linkcard]')){
      formModal('Link card',[{name:'target',label:'target card id',required:true},{name:'type',label:'relation',type:'select',options:['relates','duplicates','supersedes','parent','subtask','copied-from','copied-to'].map(x=>({value:x,label:x}))}],'link',async d=>{
        await api('/api/projects/'+SEL+'/cards/'+c.id+'/link',{method:'POST',body:JSON.stringify({target:d.target,type:d.type})});setTimeout(()=>openCard(c.id,'card'),0);refreshBoard(true)});
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
      const act=async force=>{
        const r=await api(cardApi(c.id)+'/claim',{method:'POST',body:JSON.stringify(force?{force:true}:{})});
        closeOverlay();await reloadOrg();openCard(c.id,'card');
        if(r&&r.alreadyYours)toast('You already hold '+c.id+'.');
      };
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
      formModal('Close '+c.id,[{name:'reason',label:'what holds now (optional)'}],'close',async d=>{
        await api(cardApi(c.id)+'/close',{method:'POST',body:JSON.stringify(d.reason?{reason:d.reason}:{})});
        await reloadOrg();
        setTimeout(()=>openCard(c.id,'card'),0); // after the form modal closes itself
      });
      return}
    if(e.target.closest('[data-block]')){
      formModal('Block '+c.id,[{name:'reason',label:'why it is parked',required:true}],'block',async d=>{
        await api(cardApi(c.id)+'/block',{method:'POST',body:JSON.stringify({reason:d.reason})});
        await reloadOrg();
        setTimeout(()=>openCard(c.id,'card'),0); // after the form modal closes itself
      });
      return}
    if(e.target.closest('[data-unblock]')){
      await api(cardApi(c.id)+'/unblock',{method:'POST',body:JSON.stringify({})});
      await reloadOrg();openCard(c.id,'card');
      return}
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
        {name:'estimate',label:'estimate (empty to clear)',type:'number',value:c.estimate??''},
        {name:'evergreen',label:'aging signal',type:'select',value:String(!!c.evergreen),options:[{value:'false',label:'normal'},{value:'true',label:'evergreen (hide aging)'}]},
        {name:'cover_color',label:'cover color (empty to clear)',value:c.coverColor||''},
      ].concat(customFormFields(defs,c.fields||[]));
      formModal('Edit card',fields,'save',async d=>{
        await api('/api/projects/'+SEL+'/cards/'+c.id+'/edit',{method:'POST',body:JSON.stringify({
          title:d.title,priority:d.priority||null,assignee:d.assignee||null,
          delegate:d.delegate||null,start:d.start||null,due:d.due||null,
          estimate:d.estimate?Number(d.estimate):null,evergreen:d.evergreen==='true',cover_color:d.cover_color||null,
          labels:d.labels?d.labels.split(',').map(s=>s.trim()).filter(Boolean):[],
          deps:d.deps?d.deps.split(',').map(s=>s.trim()).filter(Boolean):[],fields:customPayload(defs,d,true)})});
        openCard(c.id,'card');refreshBoard(true)});
    }
  });
  m.addEventListener('keydown',async e=>{
    if(RO||(e.key!=='Enter'&&e.key!==' '))return;
    const chk=e.target.closest('[data-check]');
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
async function refreshActivity(){
  try{const ev=await api('/api/projects/'+SEL+'/events?limit=200');
    $('#view').innerHTML=ev.length?'<table class="list"><tr><th>when</th><th>actor</th><th>action</th><th>card</th><th>detail</th></tr>'
      +ev.map(e=>'<tr><td class="mono">'+esc((e.ts||'').replace('T',' ').slice(0,16))+'</td><td>'+esc(e.actor)+'</td><td>'+esc(e.action)+'</td><td class="mono">'+esc(e.card_id||'')+'</td><td>'+esc(e.detail)+'</td></tr>').join('')+'</table>'
      :'<div class="empty">no activity yet</div>';
  }catch(err){$('#view').innerHTML='<div class="err">'+esc(err.message)+'</div>'}
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
        +'<td>'+(k.revoked?'revoked':'<button data-renk="'+esc(k.id)+'" data-label="'+esc(k.label)+'">rename</button> <button data-rk="'+esc(k.id)+'">revoke</button>')+'</td></tr>').join('')+'</table>'
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
  };
}
// ---- members: the company directory, owner only ----
// /api/members returns Registry Identity rows: scopeKind/scopeId are flat.
// /api/org.me and /api/whoami deliberately expose a nested scope object, but
// that presentation shape is not the member-management contract.
function scopeLabel(m){
  if(m.scopeKind==='org')return 'whole company';
  const id=m.scopeId;
  if(m.scopeKind==='space'){const sp=ORG.spaces.find(x=>x.id===id);return 'space: '+(sp?sp.name:id)}
  const p=findAny(id);return 'project: '+(p?p.name:id);
}
function scopeOptions(sel){
  let out='<option value="org">whole company (all spaces and projects)</option>';
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
  const sel=m?(m.scopeKind==='org'?'org':m.scopeKind+':'+m.scopeId):'org';
  return '<div class="field"><label>display name<input id="mdisplay" value="'+esc(m?m.display:'')+'" placeholder="what boards show"></label></div>'
    +'<div class="field"><label>role<select id="mrole">'
    +['read','write','owner'].map(r=>'<option value="'+r+'"'+(m&&m.role===r?' selected':'')+'>'+r+(r==='owner'?' (runs the company)':r==='write'?' (works the board)':' (looks, cannot touch)')+'</option>').join('')
    +'</select></label></div>'
    +'<div class="field"><label>scope<select id="mscope">'+scopeOptions(sel)+'</select></label></div>';
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
    ?'<button data-keym="'+esc(m.memberId)+'" aria-label="create API key for '+esc(m.username)+'">+ key</button> '
    :'';
  return '<tr'+(m.disabled?' style="opacity:.5"':'')+'><td>'+esc(m.display)+'</td><td class="mono">'+esc(m.username)+'</td>'
    +'<td>'+esc(m.kind)+'</td><td>'+esc(m.role)+'</td><td>'+esc(scopeLabel(m))+'</td>'
    +'<td class="mono" data-keycount="'+esc(m.memberId)+'">'+esc(m.keys)+'</td>'
    +'<td>'+botKey+'<button data-edm="'+esc(m.memberId)+'">edit</button> <button data-pwm="'+esc(m.memberId)+'">password</button>'
    +(m.username===ME.username?'':' <button data-delm="'+esc(m.memberId)+'" data-name="'+esc(m.display)+'">remove</button>')+'</td></tr>';
}
function provisionBotKey(m,host){
  const title='New API key for '+m.username;
  const dlg=overlay('<h3>'+esc(title)+'</h3>'
    +'<p class="setting-note">This credential acts as <code>'+esc(m.username)+'</code>: '+esc(m.role)+' on '+esc(scopeLabel(m))+'. The bot does not need to log in.</p>'
    +'<form><div class="field"><label>name<input name="label" placeholder="optional: defaults to api key #N"></label></div>'
    +'<div class="err" role="alert"></div><div class="actions"><button type="button" class="ghost" data-x>cancel</button><button class="primary" data-mint>mint key</button></div></form>',
    '',title);
  $('[data-x]',dlg).onclick=closeOverlay;
  $('form',dlg).onsubmit=async e=>{e.preventDefault();
    const submit=$('[data-mint]',dlg);submit.disabled=true;submit.textContent='minting…';
    try{
      const label=$('[name="label"]',dlg).value.trim();
      const r=await api('/api/keys?member='+encodeURIComponent(m.memberId),{method:'POST',body:JSON.stringify(label?{label}:{})});
      m.keys=Number(m.keys||0)+1;
      const count=[...host.querySelectorAll('[data-keycount]')].find(x=>x.dataset.keycount===m.memberId);
      if(count)count.textContent=String(m.keys);
      dlg.innerHTML='<h3>'+esc(r.label)+' for '+esc(m.username)+'</h3>'
        +'<div class="tokenbox">'+esc(r.token)+'</div>'
        +'<p class="warn">Copy this key now. It is never shown again.</p>'
        +'<div class="actions"><button type="button" class="ghost" data-copykey>copy</button><button type="button" class="primary" data-done>done</button></div>';
      const copy=$('[data-copykey]',dlg);copy.onclick=async()=>{try{await navigator.clipboard.writeText(r.token);copy.textContent='copied'}catch{copy.textContent='copy failed'}};
      $('[data-done]',dlg).onclick=closeOverlay;
    }catch(err){$('.err',dlg).textContent=err.message;submit.disabled=false;submit.textContent='mint key'}
  };
  const input=$('[name="label"]',dlg);if(input)input.focus();
}
async function renderMembers(host){
  let members=[];
  try{members=await api('/api/members')}catch(err){host.innerHTML='<div class="err">'+esc(err.message)+'</div>';return}
  host.innerHTML='<p style="margin-bottom:10px"><button class="primary" id="addm">+ member</button>'
    +' <span style="color:var(--muted);font-size:12px">people and bots. A username is permanent (cards are logged under it); a display name is not.</span></p>'
    +'<table class="list"><tr><th>display name</th><th>username</th><th>type</th><th>role</th><th>scope</th><th>keys</th><th></th></tr>'
    +members.map(memberRow).join('')
    +'</table>';
  $('#addm').onclick=()=>{
    const m=overlay('<h3>New member</h3>'
      +'<div class="field"><label>username<input id="musername" placeholder="a-z, 0-9, - and _" autocomplete="off"></label></div>'
      +'<p class="setting-note">Permanent: it is the actor name written into every card log.</p>'
      +'<div class="field"><label>type<select id="mkind"><option value="human">human</option><option value="bot">bot</option></select></label></div>'
      +'<div class="field"><label>password<input id="mpw" type="password" placeholder="8+ characters" autocomplete="new-password"></label></div>'
      +memberFields(null)
      +'<div class="err" id="merr"></div><div class="actions"><button id="mcancel">cancel</button><button class="primary" id="mok">create</button></div>',
      '','New member');
    $('#mcancel').onclick=closeOverlay;
    $('#mok').onclick=async()=>{
      try{
        await api('/api/members',{method:'POST',body:JSON.stringify({
          username:$('#musername').value.trim(),kind:$('#mkind').value,password:$('#mpw').value,...readMemberFields()})});
        closeOverlay();await renderMembers(host);await reloadOrg();
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
      $('#mcancel').onclick=closeOverlay;
      $('#mok').onclick=async()=>{
        try{
          await api('/api/members/'+m.memberId,{method:'PATCH',body:JSON.stringify({...readMemberFields(),disabled:$('#mdis').checked})});
          closeOverlay();await renderMembers(host);await reloadOrg();
        }catch(err){$('#merr').textContent=err.message}
      };
      return;
    }
    const pw=e.target.closest('[data-pwm]');
    if(pw)return formModal('Set password',[{name:'password',label:'new password (8+ characters)',type:'password',required:true}],'set',async d=>{
      await api('/api/members/'+pw.dataset.pwm+'/password',{method:'POST',body:JSON.stringify({password:d.password})})});
    const del=e.target.closest('[data-delm]');
    if(del)return confirmModal('Remove member','Removing '+esc(del.dataset.name)+' revokes every key and ends every session. The username stays reserved: it is the name already written into card logs and assignments, so it must never be handed to someone else.','remove',async()=>{
      await api('/api/members/'+del.dataset.delm,{method:'DELETE'});await renderMembers(host);await reloadOrg()});
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
const SH='<h4 style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:22px">';
function renderSettings(main){
  const st=THEMES.find(s=>s.id===THEME.style)||THEMES[0];
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
    +'<h4 class="setting-title" style="margin-top:22px">visual world</h4><p class="setting-note">Five complete directions. Pick the character first, then tune its color and rhythm.</p>'
    +'<div class="stiles">'+THEMES.map(s=>'<button type="button" class="stile '+(s.id===THEME.style?'on':'')+'" data-style="'+s.id+'" aria-pressed="'+(s.id===THEME.style)+'">'+stylePreview(s)+'<b>'+esc(s.name)+'</b><div class="blurb">'+esc(s.blurb)+'</div></button>').join('')+'</div>'
    +'<h4 class="setting-title">accent</h4><p class="setting-note">Each set is tuned for this world in both light and dark mode.</p>'
    +'<div class="accents">'+st.accents.map(a=>{const mode=THEME.mode==='system'?(mq.matches?'dark':'light'):THEME.mode;
      return '<button type="button" class="accpill '+(a.id===THEME.accent?'on':'')+'" data-accent="'+a.id+'" aria-pressed="'+(a.id===THEME.accent)+'"><span class="sw" style="background:'+a[mode].acc+'"></span>'+esc(a.name)+'</button>'}).join('')
    +'<label class="accpill '+(THEME.accent==='custom'?'on':'')+'" id="custpill"><input type="color" id="custcol" value="'+(THEME.custom||'#7354c4')+'">pick your own</label>'
    +'</div>'
    +'<div class="setting-pair"><div class="setting-group"><h4 class="setting-title">density</h4><p class="setting-note">A designed version of this world, not browser zoom.</p>'
    +'<div class="segsel">'+[['compact','more cards'],['relaxed','more breathing room']].map(x=>'<button type="button" data-density="'+x[0]+'" class="'+(x[0]===THEME.density?'primary':'')+'"><span>'+x[0]+'</span><small>'+x[1]+'</small></button>').join('')+'</div></div>'
    +'<div class="setting-group"><h4 class="setting-title">mode</h4><p class="setting-note">System follows each viewer’s device.</p>'
    +'<div class="segsel">'+[['system','follow device'],['light','daylight'],['dark','lights out']].map(x=>'<button type="button" data-mode="'+x[0]+'" class="'+(x[0]===THEME.mode?'primary':'')+'"><span>'+x[0]+'</span><small>'+x[1]+'</small></button>').join('')+'</div></div></div>'
    +'<p class="setting-note">Saved company-wide. Operators and public share pages use the same visual system and density.</p>'
    +'<h4 style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:22px">login page</h4>'
    +'<label style="font-size:13px;display:flex;gap:8px;align-items:center"><input type="checkbox" id="gs"> list public board links on the login page</label>'
    +'<h4 style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:22px">company data</h4>'
    +'<div style="display:flex;gap:8px;flex-wrap:wrap"><button id="orgexp">download company export</button>'
    +'<button id="demoload">load the Scoops Empire demo</button></div>'
    +'<p style="color:var(--muted);font-size:12px;margin-top:6px">The export is restore-grade JSON: every space, project, board, card, member (password hashes included), api key hash, public share, and private feed capability. Store it like a credential: it is one. Uploaded files are NOT inside it: they live in the R2 bucket (the export lists their keys), so back the bucket up separately before any deletion. File urls are permanent bearer links: anyone holding one can fetch that file, and revoking a share does not revoke it. The demo adds a sample ice cream company as a new space.</p>'
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
  api('/api/org/shares').then(list=>{
    const el=$('#mshares');if(!el)return;
    el.innerHTML=list.length?'<table class="list"><tr><th>project</th><th>kind</th><th>member / scope</th><th>label</th><th>url</th><th>created</th><th></th></tr>'
      +list.map(s=>{const feed=s.kind==='feed';const scope=s.cardId?'card '+s.cardId:s.laneId?'lane '+s.laneId:s.filterId?'filter '+s.filterId:'board';const href=feed?'/feeds/'+s.token+'.rss':'/s/'+s.token;
        return '<tr'+(s.revoked?' style="opacity:.5"':'')+'><td>'+esc(s.projectName)+'</td><td>'+esc(s.kind)+'</td><td>'+esc((feed?(s.memberUsername||'removed member')+' · ':'')+scope)+'</td><td>'+esc(s.label)+'</td>'
        +'<td class="mono"><a href="'+esc(href)+'" target="_blank" style="color:var(--acc)">'+esc(href.slice(0,18))+'…</a></td>'
        +'<td class="mono">'+esc(s.created.slice(0,10))+'</td><td><button data-delsh="'+esc(s.id)+'">delete</button></td></tr>';}).join('')+'</table>'
      :'<div class="empty">no capabilities</div>';
  }).catch(()=>{});
  const save=async next=>{
    try{const saved=await api('/api/settings',{method:'POST',body:JSON.stringify(next)});applyTheme(saved);renderSettings(main)}
    catch(err){$('#serr').textContent=err.message}
  };
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
  $('#custcol').oninput=e=>applyTheme({...THEME,accent:'custom',custom:e.target.value});
  $('#custcol').onchange=e=>save({...THEME,accent:'custom',custom:e.target.value});
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
    if(dsh){await api('/api/shares/'+dsh.dataset.delsh,{method:'DELETE'});renderSettings(main);return}
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
