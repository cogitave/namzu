"use strict";
// Exercise the updated native UI with its fixed Turkish preview. No authored prompt.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
assert.equal(process.platform,"win32");
const privateRoot=path.join(process.env.LOCALAPPDATA,"Namzu","Development");
const config=JSON.parse(fs.readFileSync(path.join(privateRoot,"launch.json")));
const pid=Number(fs.readFileSync(path.join(privateRoot,"desktop.pid"),"utf8"));
process.kill(pid,0);
const output=path.join(__dirname,"artifacts/native-renderer-preview.json");
assert(!fs.existsSync(output));
const {chromium}=require(path.join(privateRoot,"runtime/packages/p39"));
(async()=>{
 const port=Number(fs.readFileSync(path.join(process.env.APPDATA,"Namzu","DevToolsActivePort"),"utf8").split(/\r?\n/)[0]);
 const browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
 let page;
 try {
  page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url()===new URL(config.url).href);
  assert(page);
  const before=await page.evaluate(async()=>{
   const state=await window.namzu.workspace();
   const win=state.layout.windows.find(item=>item.id===state.windowId);
   const visit=node=>!node?[]:node.kind==='group'?[node]:[...visit(node.first),...visit(node.second)];
   const group=visit(win.root).find(item=>item.id===win.focusedGroupId);
   const projects=await window.namzu.projects();
   const rows=(await Promise.all(projects.filter(item=>item.status==='ready').map(item=>window.namzu.conversations(item.id)))).flat();
   const view=rows.find(item=>item.id===group.activeTabId);
   if(!view) throw new Error('The active conversation is missing.');
   const history=await window.namzu.openConversation(view.projectId,view.id);
   if(history.thread?.running||history.thread?.responding||history.thread?.queued?.length||history.thread?.permissions?.length) throw new Error('Active chat must be idle.');
   return {id:view.id,projectId:view.projectId,messages:history.messages,draft:await window.namzu.draft(view.id),settings:await window.namzu.draftSettings(view.id),speech:await window.namzu.localSpeechState()};
  });
  assert.equal(before.speech.installation,'ready');
  assert.equal(before.speech.settings.enabled,false,'Preview must preserve the disabled preference.');
  await page.evaluate(()=>{
   const probe={frames:0,endedSources:0,samples:0,sequence:0,reason:undefined,error:undefined,firstAudioMs:undefined,started:performance.now()};
   let resolve;
   const done=new Promise(yes=>resolve=yes);
   const original=AudioContext.prototype.createBufferSource;
   AudioContext.prototype.createBufferSource=function(...args){
    const source=original.apply(this,args);
    source.addEventListener('ended',()=>probe.endedSources++);
    return source;
   };
   const unsubscribe=window.namzu.onLocalSpeechEvent(event=>{
    if(event.type==='audio'){
     if(event.sequence!==probe.sequence++) {probe.error='Noncontiguous audio sequence';resolve();return;}
     probe.frames++;
     probe.samples+=atob(event.pcmBase64).length/2;
     if(probe.firstAudioMs===undefined) probe.firstAudioMs=performance.now()-probe.started;
    } else if(event.type==='error') {probe.error=event.message;resolve();}
    else if(event.type==='end') {probe.reason=event.reason;probe.elapsedMs=performance.now()-probe.started;resolve();}
   });
   window.__namzuVoiceProof={probe,done,restore:()=>{unsubscribe();AudioContext.prototype.createBufferSource=original;}};
  });
  await page.getByRole('button',{name:'Voice settings',exact:true}).click();
  const preview=page.getByRole('button',{name:'Preview voice',exact:true});
  await preview.waitFor();
  await preview.click();
  const audio=await page.evaluate(async()=>{
   await window.__namzuVoiceProof.done;
   return {...window.__namzuVoiceProof.probe};
  });
  assert(!audio.error, audio.error);
  assert.equal(audio.reason,'completed');
  assert(audio.frames>0);
  assert.equal(audio.endedSources,audio.frames,'Every actual WebAudio source must end before backend completion.');
  assert.equal(audio.samples,82560,'Correct fixed sample must retain its 3.44s acoustic plan.');
  const after=await page.evaluate(async({id,projectId})=>({messages:(await window.namzu.openConversation(projectId,id)).messages,draft:await window.namzu.draft(id),settings:await window.namzu.draftSettings(id),speech:await window.namzu.localSpeechState()}),before);
  assert.deepEqual(after.messages,before.messages);
  assert.equal(after.draft,before.draft);
  assert.deepEqual(after.settings,before.settings);
  assert.deepEqual(after.speech.settings,before.speech.settings);
  await page.locator('.local-speech-popup').screenshot({path:path.join(__dirname,'artifacts/native-voice-settings.png')});
  await page.keyboard.press('Escape');
  const timeline=await page.evaluate(()=>({
   visibleMessageClocks:[...document.querySelectorAll('.normal-transcript .message time')].map(item=>({dateTime:item.dateTime,source:item.title.startsWith('Recorded in conversation:')?'journal':'other'})),
   searchRows:[...document.querySelectorAll('.tool[data-tool-call-id^="provider-hosted-web-search:"]')].map(item=>({state:item.dataset.toolState,label:item.querySelector('.tool-label')?.textContent,time:item.querySelector('time')?.dateTime})),
   externalLinks:document.querySelectorAll('a.message-link').length,
  }));
  assert(timeline.visibleMessageClocks.length>0);
  assert(timeline.visibleMessageClocks.every(item=>item.source==='journal'));
  const disclosure=page.locator('[data-activity-turn] > .activity-trigger').last();
  const wasExpanded=await disclosure.getAttribute('aria-expanded');
  if(wasExpanded!=='true') await disclosure.click();
  const search=page.locator('.tool[data-tool-call-id^="provider-hosted-web-search:"]');
  await search.first().waitFor();
  const searchProof=await search.first().evaluate(item=>({state:item.dataset.toolState,label:item.querySelector('.tool-label')?.textContent,time:item.querySelector('time')?.dateTime,title:item.querySelector('time')?.title}));
  assert.equal(searchProof.state,'completed');
  assert(searchProof.label.includes('RunPod'));
  assert(searchProof.time && searchProof.title.startsWith('Recorded in conversation:'));
  await search.first().screenshot({path:path.join(__dirname,'artifacts/native-web-search-step.png')});
  if(wasExpanded!=='true') await disclosure.click();
  const receipt={passed:true,at:new Date().toISOString(),platform:'win32',nativePid:pid,fixedSampleOnly:true,providerRequests:0,realWebAudio:true,
   audio:{frames:audio.frames,endedSources:audio.endedSources,audioSeconds:audio.samples/24000,firstAudioMs:audio.firstAudioMs,elapsedMs:audio.elapsedMs},
   resources:after.speech.resources,preferencesPreserved:true,messageBodyDigest:crypto.createHash('sha256').update(JSON.stringify(before.messages)).digest('hex'),messagesDraftModelPreserved:true,
   transcript:{messageClocks:timeline.visibleMessageClocks.length,clockSource:'journal',webSearchState:searchProof.state,actualSearchClock:searchProof.time,externalLinks:timeline.externalLinks},
   limitations:['Real audio nodes ended; speaker audibility and subjective Turkish pronunciation were not rated.','The fixed sample is task-owned; actual user messages were not spoken or published.']};
  fs.writeFileSync(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(receipt));
 }finally{
  if(page) await page.evaluate(()=>{window.__namzuVoiceProof?.restore();delete window.__namzuVoiceProof;}).catch(()=>{});
  await browser.close();
 }
 process.kill(pid,0);
})().catch(error=>{console.error(error.name+': '+error.message);process.exitCode=1;});
