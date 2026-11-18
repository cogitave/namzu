/**
 * The page the working pill shows. It draws what the main process sends and reports button presses;
 * it holds no state of its own and reads nothing but text, which it sets as text and never as markup.
 */
export const PILL_WIDTH = 392
export const PILL_COLLAPSED_HEIGHT = 52

export function pillPage(): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Namzu working</title>
<style>
:root{color-scheme:dark;--bg:#1b1b1d;--fg:#f2f2f3;--mute:#a4a4aa;--line:#3a3a40;--green:#7cff8a;--red:#ff6b6b;--warn:#ffcf5c}
*{box-sizing:border-box}
html,body{margin:0;background:transparent;font:13px/1.35 "Segoe UI",system-ui,-apple-system,sans-serif;color:var(--fg);user-select:none;overflow:hidden}
.pill{margin:2px;border:1px solid var(--line);background:var(--bg);border-radius:14px;padding:9px 10px 9px 12px;box-shadow:0 6px 22px rgba(0,0,0,.45)}
.row{display:flex;align-items:center;gap:10px;min-height:30px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--green);flex:none;animation:p 1.4s ease-in-out infinite}
@keyframes p{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.dot{animation:none}}
.text{min-width:0;flex:1}
.title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.step{color:var(--mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}
button{font:inherit;color:var(--fg);background:#2a2a2e;border:1px solid var(--line);border-radius:8px;padding:5px 11px;cursor:pointer}
button:hover{background:#34343a}
button.stop{flex:none}
.ask{margin-top:8px;border-top:1px solid var(--line);padding-top:8px}
.ask .q{font-weight:600}
.ask .d{color:var(--mute);margin-top:2px}
.ask .w{color:var(--warn);margin-top:2px}
.btns{display:flex;gap:6px;margin-top:8px;justify-content:flex-end}
button.allow{background:var(--green);color:#06210b;border-color:var(--green);font-weight:600}
button.deny{border-color:#5a3a3a}
[hidden]{display:none!important}
</style></head>
<body><div class="pill" id="pill" role="status" aria-live="polite">
<div class="row"><span class="dot" aria-hidden="true"></span>
<div class="text"><div class="title" id="title"></div><div class="step" id="step"></div></div>
<button class="stop" id="stop" type="button" aria-label="Stop Namzu">Stop</button></div>
<div class="ask" id="ask" hidden role="group" aria-labelledby="q">
<div class="q" id="q"></div><div class="d" id="d"></div><div class="w" id="w"></div>
<div class="btns"><button class="deny" id="deny" type="button">Deny</button><button id="once" type="button">Allow once</button><button class="allow" id="allow" type="button">Allow</button></div>
</div></div>
<script>
const $=(id)=>document.getElementById(id);
let view=null;
window.pill.onFlags((f)=>{document.documentElement.dataset.captureExcluded=String(!!(f&&f.captureExcluded));document.documentElement.dataset.captureEffective=String(!!(f&&f.captureEffective));document.documentElement.dataset.focusable=String(!!(f&&f.focusable))});
window.pill.onView((v)=>{
  view=v;
  $('title').textContent='Namzu is using '+v.app;
  $('step').textContent=v.step;
  const a=v.approval;
  $('ask').hidden=!a;
  if(a){
    $('q').textContent=a.title;
    $('d').textContent=a.detail||'';$('d').hidden=!a.detail;
    $('w').textContent=a.warning||'';$('w').hidden=!a.warning;
    $('allow').textContent=a.choices.includes('once')?'Allow':'Allow';
    $('once').hidden=!a.choices.includes('once');
  }
  document.documentElement.dataset.mode=a?'approval':'working';
});
$('stop').addEventListener('click',()=>{if(view)window.pill.act({type:'stop',sessionId:view.sessionId})});
for(const choice of ['allow','once','deny'])$(choice).addEventListener('click',()=>{if(view&&view.approval)window.pill.act({type:'answer',requestId:view.approval.requestId,choice})});
</script></body></html>`
}
