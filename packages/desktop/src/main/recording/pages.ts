import { RECORDING_WORDS } from '../../shared/recording-protocol.js'

/**
 * The two small windows of a recording as pages: the chooser and the pill. Each draws what main
 * sends and reports button presses; neither holds state of its own, reads anything but text, and sets
 * it as text, never as markup. Colours follow the system light or dark setting.
 */

export const CHOOSER_WIDTH = 520
/** The first height; the page then asks for the height its content needs. */
export const CHOOSER_HEIGHT = 480
export const CHOOSER_MIN_HEIGHT = 340
export const CHOOSER_MAX_HEIGHT = 760
export const PILL_WIDTH = 488
export const PILL_HEIGHT = 108

const TOKENS = `:root{color-scheme:light;--bg:#fbfbfa;--fg:#1c1c1e;--mute:#66666e;--line:#dcdcdf;--card:#f1f1f2;--card-hover:#e8e8ea;--accent:#1c1c1e;--accent-fg:#ffffff;--red:#d92d2d;--red-text:#b42318;--warn:#8a5a00;--focus:#3b82f6}
:root[data-theme=dark]{color-scheme:dark;--bg:#1b1b1d;--fg:#f2f2f3;--mute:#a4a4aa;--line:#3a3a40;--card:#26262a;--card-hover:#303036;--accent:#f2f2f3;--accent-fg:#1b1b1d;--red:#ff6b6b;--red-text:#ff6b6b;--warn:#ffcf5c;--focus:#7aa7ff}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.45 "Segoe UI",system-ui,-apple-system,sans-serif;user-select:none;overflow:hidden}
button,select{font:inherit;color:var(--fg)}
button{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 12px;cursor:pointer}
button:hover:not(:disabled){background:var(--card-hover)}
button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
button:disabled{opacity:.5;cursor:default}
button.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent);font-weight:600}
button.primary:hover:not(:disabled){opacity:.9;background:var(--accent)}
[hidden]{display:none!important}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}`

export function chooserPage(): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${RECORDING_WORDS.title}</title>
<style>
${TOKENS}
body{padding:20px 22px 18px;display:flex;flex-direction:column;gap:12px}
h1{font-size:16px;line-height:1.3;margin:0;font-weight:600}
p{margin:0}
.warn{color:var(--warn)}
.group{display:flex;flex-direction:column;gap:6px}
.label{font-size:12px;color:var(--mute);font-weight:600}
.displays{display:flex;gap:8px;flex-wrap:wrap;max-height:300px;overflow:auto;padding:2px}
.display{width:128px;padding:6px;text-align:left;display:flex;flex-direction:column;gap:4px;border-radius:10px}
.display img{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:6px;border:1px solid var(--line);background:#000}
.display[aria-checked=true]{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.display span{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.display .size{color:var(--mute);font-size:11px}
.row{display:flex;align-items:center;gap:10px;min-height:30px}
.row label{flex:1;display:flex;align-items:center;gap:8px}
select{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:5px 8px;max-width:210px}
.hint{font-size:12px;color:var(--mute)}
kbd{font:inherit;background:var(--card);border:1px solid var(--line);border-radius:5px;padding:0 5px}
.spacer{height:2px}
.buttons{display:flex;gap:8px;justify-content:flex-end}
</style></head>
<body>
<h1 id="title">${RECORDING_WORDS.title}</h1>
<p id="disclosure"></p>
<p class="warn" id="warning"></p>
<div class="group" id="screens"><div class="label">Screen</div><div class="displays" id="displays" role="radiogroup" aria-label="Screen"></div></div>
<div class="group" id="voice">
<div class="row"><label><input type="checkbox" id="voiceOn"><span>Record voice narration</span></label>
<select id="mic" aria-label="Microphone"></select></div>
<p class="hint" id="voiceHint"></p></div>
<p class="hint" id="shortcut"></p>
<div class="spacer"></div>
<div class="buttons"><button id="cancel" type="button">Cancel</button><button id="settings" type="button" hidden>Open settings</button><button id="continue" type="button" hidden>Continue to recording</button><button class="primary" id="start" type="button" disabled>Start recording</button></div>
<script>
const $=(id)=>document.getElementById(id);
let opened=performance.now();
let init=null,chosen=null;
const answer=(a)=>window.recording.answer(a);
window.recording.onTheme((dark)=>{document.documentElement.dataset.theme=dark?'dark':'light'});
function ready(){return init&&performance.now()-opened>=init.inputProtectionMs}
function pick(id){chosen=id;for(const o of $('displays').children){const on=o.dataset.id===id;o.setAttribute('aria-checked',String(on));o.tabIndex=on?0:-1}}
window.recording.onChooser((v)=>{
  init=v;
  $('disclosure').textContent=v.disclosure;
  $('warning').textContent=v.warning;
  const box=$('displays');box.textContent='';
  chosen=(v.displays.find((d)=>d.underCursor)||v.displays.find((d)=>d.primary)||v.displays[0]||{}).id;
  $('screens').hidden=v.displays.length===0;
  for(const d of v.displays){
    const b=document.createElement('button');b.type='button';b.className='display';b.setAttribute('role','radio');
    b.setAttribute('aria-checked',String(d.id===chosen));b.tabIndex=d.id===chosen?0:-1;b.dataset.id=d.id;
    const img=document.createElement('img');img.alt='';img.src=d.thumb;
    const t=document.createElement('span');t.textContent=d.label;t.title=d.label;
    const z=document.createElement('span');z.className='size';z.textContent=d.width+' x '+d.height;
    b.append(img,t,z);
    b.addEventListener('click',()=>pick(d.id));
    b.addEventListener('keydown',(e)=>{const k=e.key;const fwd=k==='ArrowRight'||k==='ArrowDown',back=k==='ArrowLeft'||k==='ArrowUp';if(!fwd&&!back)return;e.preventDefault();const all=[...box.children];const i=all.indexOf(b);const n=all[(i+(fwd?1:all.length-1))%all.length];pick(n.dataset.id);n.focus()});
    box.append(b);
  }
  $('voiceOn').checked=v.voice.on&&v.voice.available;
  $('voiceOn').disabled=!v.voice.available;
  const mic=$('mic');mic.textContent='';
  for(const m of v.voice.microphones){const o=document.createElement('option');o.value=m.id;o.textContent=m.label;if(m.id===v.voice.microphone)o.selected=true;mic.append(o)}
  mic.disabled=!v.voice.available;
  $('voiceHint').textContent=v.voice.available?(v.voice.language||''):v.voiceMissing;
  $('shortcut').textContent='';
  const k=document.createElement('kbd');k.textContent=v.shortcut;
  $('shortcut').append('To end the recording from anywhere, press ',k,'.');
  opened=performance.now();
  if(v.permission){$('start').hidden=true;$('settings').hidden=false;$('settings').classList.add('primary');$('continue').hidden=false}
  setTimeout(()=>{$('start').disabled=false},v.inputProtectionMs);
  requestAnimationFrame(()=>{window.recording.size(document.body.offsetHeight);const c=box.querySelector('[aria-checked=true]');(c||$('cancel')).focus()});
});
$('start').addEventListener('click',()=>{if(!ready()||!init)return;answer({type:'start',displayId:chosen||'',voice:$('voiceOn').checked,microphone:$('mic').value})});
$('cancel').addEventListener('click',()=>answer({type:'cancel'}));
$('settings').addEventListener('click',()=>answer({type:'open-settings'}));
$('continue').addEventListener('click',()=>answer({type:'continue'}));
document.addEventListener('keydown',(e)=>{if(e.key==='Escape'){e.preventDefault();answer({type:'cancel'})}});
</script></body></html>`
}

export function pillPage(): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Namzu recording</title>
<style>
${TOKENS}
html,body{background:transparent}
.pill{margin:14px;border:1px solid var(--line);background:var(--bg);border-radius:14px;padding:8px 10px 8px 12px;box-shadow:0 6px 22px rgba(0,0,0,.3)}
.row{display:flex;align-items:center;gap:10px;min-height:32px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--red);flex:none;animation:p 1.4s ease-in-out infinite}
.dot[data-still=true]{animation:none;background:var(--mute)}
@keyframes p{50%{opacity:.35}}
.text{min-width:0;flex:1 1 0;display:flex;align-items:baseline;gap:8px;overflow:hidden}
.title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:0 1 auto}
.time{font-variant-numeric:tabular-nums;color:var(--mute);flex:none}
.left{color:var(--warn);font-size:12px;white-space:nowrap;flex:none}
.meter{width:34px;height:6px;border-radius:3px;background:var(--card);overflow:hidden;flex:none}
.meter i{display:block;height:100%;width:0;background:var(--red);transition:width .1s}
button{padding:4px 10px;border-radius:8px;flex:none}
button.warnbtn{color:var(--red-text)}
.note{margin-top:4px;font-size:12px;color:var(--mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
button.note{background:none;border:0;padding:0;text-align:left;text-decoration:underline;cursor:pointer;width:100%}
</style></head>
<body><div class="pill" role="group" aria-label="Namzu recording">
<div class="row"><span class="dot" id="dot" aria-hidden="true"></span>
<div class="text"><span class="title" id="title" role="status" aria-live="polite"></span><span class="time" id="time" aria-hidden="true"></span><span class="left" id="left" aria-hidden="true"></span></div>
<span class="meter" id="meterBox" hidden aria-hidden="true"><i id="meter"></i></span>
<button id="pause" type="button">Pause</button><button id="done" type="button">Done</button><button class="warnbtn" id="discard" type="button">Discard</button></div>
<div class="note" id="note" role="status" aria-live="polite" hidden></div></div>
<script>
const $=(id)=>document.getElementById(id);
const clock=(ms)=>{const s=Math.max(0,Math.floor(ms/1000));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')};
const NOTES={'narration-disconnected':${JSON.stringify(RECORDING_WORDS.narrationDisconnected)},'typing-not-recorded':${JSON.stringify(RECORDING_WORDS.typingNotRecorded)},'screenshots-failing':${JSON.stringify(RECORDING_WORDS.screenshotsFailing)},'secure-field':'Paused while a password field is in use.','no-microphone':'No microphone: recording without voice.','limit':${JSON.stringify(RECORDING_WORDS.limitReached)}};
let view=null;
function draw(v){
  view=v;const s=v.state;
  const away=s.kind==='away',paused=s.kind==='paused',busy=s.kind==='processing'||s.kind==='expired';
  $('dot').dataset.still=String(s.kind!=='recording');
  $('title').textContent=s.kind==='recording'?'Recording':paused?'Paused':away?'Stopped, kept until '+s.keptUntil:s.kind==='processing'?'Processing':${JSON.stringify(RECORDING_WORDS.discardedAfterLimit)};
  $('time').textContent=(s.kind==='recording'||paused)?clock(s.elapsedMs):'';
  $('left').textContent=s.kind==='recording'&&s.leftMs!==undefined?clock(s.leftMs)+' left':'';
  $('meterBox').hidden=!(s.kind==='recording'&&s.voice);
  if(s.kind==='recording'&&s.voice)$('meter').style.width=Math.round(Math.min(1,s.level||0)*100)+'%';
  $('pause').hidden=busy;$('done').hidden=busy;$('discard').hidden=busy;
  $('pause').textContent=(paused||away)?'Resume':'Pause';
  const n=$('note');
  if(v.note){n.hidden=false;n.textContent=NOTES[v.note]||'';
    if(v.note==='narration-disconnected'){n.className='note';const b=document.createElement('button');b.className='note';b.type='button';b.textContent=NOTES[v.note];b.addEventListener('click',()=>window.recording.pill({type:'reconnect'}));n.textContent='';n.append(b)}else n.className='note'}
  else n.hidden=true;
}
window.recording.onTheme((dark)=>{document.documentElement.dataset.theme=dark?'dark':'light'});
window.recording.onPill(draw);
$('pause').addEventListener('click',()=>{if(!view)return;const k=view.state.kind;window.recording.pill({type:(k==='paused'||k==='away')?'resume':'pause'})});
$('done').addEventListener('click',()=>window.recording.pill({type:'done'}));
$('discard').addEventListener('click',()=>window.recording.pill({type:'discard'}));
</script></body></html>`
}
