"use strict";
// Inspect the final native transcript and its real source-link markup; no prompt or shell link click.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
assert.equal(process.platform,'win32');
const root=path.join(process.env.LOCALAPPDATA,'Namzu','Development');
const config=JSON.parse(fs.readFileSync(path.join(root,'launch.json')));
const pid=Number(fs.readFileSync(path.join(root,'desktop.pid'),'utf8'));
process.kill(pid,0);
const {chromium}=require(path.join(root,'runtime/packages/p39'));
const output=path.join(__dirname,'artifacts/native-final-transcript-proof.json');
assert(!fs.existsSync(output));
(async()=>{
 const port=Number(fs.readFileSync(path.join(process.env.APPDATA,'Namzu','DevToolsActivePort'),'utf8').split(/\r?\n/)[0]);
 const browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
 try{
  const page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url()===new URL(config.url).href);
  assert(page);
  const disclosures=page.locator('[data-activity-turn] > .activity-trigger');
  await disclosures.first().waitFor({state:'visible'});
  const previousStates=await disclosures.evaluateAll(items=>items.map(item=>item.getAttribute('aria-expanded')));
  const scrollPositions=await page.evaluate(()=>[...document.querySelectorAll('*')].filter(item=>item.scrollHeight>item.clientHeight&&item.scrollTop>0).map(item=>({className:item.className,top:item.scrollTop})));
  try{
  // Collapsible bodies are unmounted while closed; inspect the actual disclosed markup.
  for(let index=0;index<previousStates.length;index++) if(previousStates[index]!=='true') await disclosures.nth(index).click();
  await page.evaluate(()=>Promise.all(document.getAnimations().filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{}))));
  await page.locator('.normal-transcript .message time').first().waitFor({state:'attached'});
  await page.evaluate(()=>document.fonts.ready);
  const clocks=await page.locator('.normal-transcript .message time').evaluateAll(items=>items.map(item=>({iso:item.dateTime,source:(item.title||item.parentElement.title).startsWith('Recorded in conversation:')?'journal':'other'})));
  assert(clocks.length>0&&clocks.every(item=>item.source==='journal'));
  const links=await page.locator('.normal-transcript .message a.message-link').evaluateAll(items=>items.map(item=>({protocol:new URL(item.href).protocol,parent:item.parentElement.tagName})));
  assert(links.length>=4,'Existing source URLs should remain clickable web links.');
  assert(links.every(item=>['http:','https:'].includes(item.protocol)));
  assert.equal(await page.evaluate(()=>typeof window.namzu.openExternal),'function');
  const disclosure=disclosures.last();
   await page.evaluate(()=>Promise.all(document.getAnimations().filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{}))));
   const activity=disclosure.locator('..');
   const search=activity.locator('.tool[data-tool-call-id^="provider-hosted-web-search:"]').last();
   await search.waitFor({state:'visible'});
   await search.scrollIntoViewIfNeeded();
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   await page.mouse.move(0,0);
   const step=await search.evaluate(item=>({state:item.dataset.toolState,time:item.querySelector('time')?.dateTime,source:item.querySelector('time')?.title.startsWith('Recorded in conversation:')?'journal':'other',text:item.querySelector('.tool-label')?.textContent,height:item.getBoundingClientRect().height,clockOpacity:getComputedStyle(item.querySelector('time')).opacity,statusClip:getComputedStyle(item.querySelector('.tool-status')).clip}));
   assert.equal(step.state,'completed');assert.equal(step.source,'journal');assert(step.height>=32);
   assert.equal(step.text,'Searched the web');
   assert.equal(step.clockOpacity,'0');
   assert.equal(step.statusClip,'rect(0px, 0px, 0px, 0px)');
   assert((await disclosure.innerText()).startsWith('Worked for'));
   assert.equal(await activity.getByText('Actions completed',{exact:true}).count(),0);
   await search.screenshot({path:path.join(__dirname,'artifacts/native-final-web-search-step.png')});
   const receipt={passed:true,at:new Date().toISOString(),platform:'win32',nativePid:pid,providerRequests:0,authoredPrompts:0,sourceLinks:{count:links.length,inlineCodeCount:links.filter(item=>item.parent==='CODE').length,protocols:[...new Set(links.map(item=>item.protocol))],mainBridgePresent:true,externalBrowserOpened:false},messageClocks:{count:clocks.length,source:'journal'},webSearch:{state:step.state,source:step.source,startedAt:step.time,humanSummary:step.text,quietClocks:true,quietRoutineCompletion:true,duplicateActionHeader:false},limits:['UI uses existing private conversation; message bodies are not published.','Native source URLs are ordinary Markdown links; sole inline-code URL handling is separately proven with the actual renderer fixture.','Actual external browser launch is covered by validation/bridge tests, not an unsolicited native link click.']};
   fs.writeFileSync(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
   console.log(JSON.stringify(receipt));
  }finally{
   for(let index=0;index<previousStates.length;index++) if((await disclosures.nth(index).getAttribute('aria-expanded'))!==previousStates[index]) await disclosures.nth(index).click();
   await page.evaluate(positions=>{for(const position of positions){const item=[...document.querySelectorAll('*')].find(item=>item.className===position.className&&item.scrollHeight>item.clientHeight);if(item)item.scrollTop=position.top;}},scrollPositions);
  }
 }finally{await browser.close();}
 process.kill(pid,0);
})().catch(error=>{console.error(error.name+': '+error.message);process.exitCode=1;});
