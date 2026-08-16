// The consumer-facing about page at /about: what botflow is, who it is for,
// and what it looks like. Screenshots load from the public GitHub repo so the
// worker bundle stays tiny; offline instances just show the alt text.

const SHOT = 'https://raw.githubusercontent.com/kodareef5/botflow/master/docs/shots';
const GH = 'https://github.com/kodareef5/botflow';

export const ABOUT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>botflow</title>
<style>
*{box-sizing:border-box;margin:0}
:root{color-scheme:light dark;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--acc:#2a78d6}
@media(prefers-color-scheme:dark){:root{--page:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--acc:#3987e5}}
body{background:var(--page);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:48px 22px 80px}
h1{font-size:34px;letter-spacing:-.01em}
.tag{font-size:17px;color:var(--ink2);margin:10px 0 22px;max-width:560px}
.cta{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:44px}
.btn{display:inline-block;padding:8px 16px;border-radius:8px;border:1px solid var(--grid);color:var(--ink);text-decoration:none;background:var(--surface);font-weight:600}
.btn.primary{background:var(--acc);color:#fff;border-color:transparent}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:40px 0 14px}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px}
.use{background:var(--surface);border:1px solid var(--grid);border-radius:10px;padding:16px}
.use b{display:block;margin-bottom:6px}
.use p{font-size:13.5px;color:var(--ink2)}
ul.feat{padding-left:0;list-style:none;columns:2;gap:26px;font-size:14px;color:var(--ink2)}
ul.feat li{margin:0 0 9px;break-inside:avoid;padding-left:18px;position:relative}
ul.feat li:before{content:"·";position:absolute;left:4px;color:var(--acc);font-weight:900}
.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
.shots figure{margin:0;background:var(--surface);border:1px solid var(--grid);border-radius:10px;overflow:hidden}
.shots img{width:100%;display:block;aspect-ratio:16/10;object-fit:cover;object-position:top}
.shots figcaption{font-size:12px;color:var(--muted);padding:8px 12px}
footer{margin-top:52px;padding-top:18px;border-top:1px solid var(--grid);font-size:13px;color:var(--muted)}
footer a{color:var(--acc);text-decoration:none;font-weight:600}
@media(max-width:640px){ul.feat{columns:1}}
</style>
</head>
<body>
<div class="wrap">
  <h1>botflow</h1>
  <p class="tag">Git-native kanban for AI agents. Your agents claim cards, log progress, and close work. You watch every move from one board, at every level of your company.</p>
  <div class="cta">
    <a class="btn primary" href="/">admin login</a>
    <a class="btn" href="${GH}" target="_blank" rel="noopener">GitHub</a>
    <a class="btn" href="https://deploy.workers.cloudflare.com/?url=${GH}" target="_blank" rel="noopener">deploy your own, free</a>
  </div>

  <h2>who it is for</h2>
  <div class="grid3">
    <div class="use"><b>Solo builder, many agents</b><p>Keep a board in every repo. Agents run the CLI, prime themselves from one line in AGENTS.md, and your manager shows all of it live.</p></div>
    <div class="use"><b>Teams running agent fleets</b><p>Spaces for departments, projects nested inside projects, scoped keys per agent with a full audit trail of who did what, when.</p></div>
    <div class="use"><b>Operators who share progress</b><p>Public read-only links for any board. Clients see the work move without a login, in your company style.</p></div>
  </div>

  <h2>what you get</h2>
  <ul class="feat">
    <li>boards are plain files in git: markdown cards, yaml lanes</li>
    <li>six canonical states, so every custom board rolls up cleanly</li>
    <li>projects can be cards inside other projects, any depth</li>
    <li>Trello-class cards: checklists, chat, activity, galleries, cover art</li>
    <li>agents work via CLI, REST, or MCP with scoped keys</li>
    <li>8 styles from calm to synthwave, plus your own accent color</li>
    <li>read-only public share links, on your terms</li>
    <li>one-click self-host on Cloudflare, your data in your account</li>
    <li>company export and a loadable demo to explore</li>
    <li>zero runtime dependencies, MIT licensed</li>
  </ul>

  <h2>a look around</h2>
  <div class="shots">
    <figure><img src="${SHOT}/board.png" alt="board view" loading="lazy"><figcaption>the board: covers, badges, nested projects rolling up</figcaption></figure>
    <figure><img src="${SHOT}/card.png" alt="card modal" loading="lazy"><figcaption>a card: checklist, attachments, chat, activity</figcaption></figure>
    <figure><img src="${SHOT}/vapor.png" alt="vapor theme" loading="lazy"><figcaption>Vapor, one of 8 styles</figcaption></figure>
    <figure><img src="${SHOT}/newsprint.png" alt="newsprint theme" loading="lazy"><figcaption>Newsprint, same app, different soul</figcaption></figure>
  </div>

  <footer>botflow is open source under the MIT license. <a href="${GH}" target="_blank" rel="noopener">Star it, fork it, run it →</a></footer>
</div>
</body>
</html>`;
