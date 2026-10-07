/** Bounded actual-renderer audit; isolated sample data, no native or provider calls. */
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {join,resolve} from 'node:path'
import {installFixture} from '../transcript-motion-20261007/fixture.mjs'

const repo=resolve(process.argv[2]??'.')
const artifacts=join(repo,'research/chat-surface-20261007/artifacts')
const verify=process.argv.includes('--verify')
const fixture=JSON.parse(await readFile(join(repo,'research/transcript-search-timing-20261007/artifacts/journal-fixtures.json'),'utf8'))
fixture.coldHistory.messages[0].text='Sohbet ekranını daha rahat kullanmak istiyorum. Nereden başlamalıyız?'
fixture.coldHistory.messages[1].text='Önce mesajların okunmasını, sonra da yazma alanını toparlayabiliriz.\n\n- Uzun yanıtlar tek bakışta taranabilmeli.\n- Kaynaklar gerektiğinde açılabilmeli.\n- Proje ve model seçimi yazmayı bölmemeli.\n\n| Alan | Öncelik |\n| --- | --- |\n| Mesaj akışı | Okunabilirlik |\n| Yazma alanı | Kolay erişim |\n\nİstersen ilk olarak sohbet akışından başlayalım.'
fixture.persistenceHistories={'sample-thread-7':{partial:false,messages:[
 {role:'assistant',text:'Hey! I’m Kiro. Ready when you are. What’s on your mind?',status:'completed',messageId:'audit-pal-welcome',phase:'final_answer',time:{at:Date.parse(fixture.journalClock.user),source:'journal'}},
 {role:'user',text:'Bugün biraz yoğunum. Kaldığımız işi bana kısaca hatırlatır mısın?',status:'completed',messageId:'audit-pal-user',time:{at:Date.parse(fixture.journalClock.user)+1000,source:'journal'}},
 {role:'assistant',text:'Tabii. Sohbet ekranının okunabilirliğini ve yazma alanını toparlıyorduk.\n\nİstersen ben küçük bir liste çıkarayım, sen uygun olduğunda birlikte bakarız.',status:'completed',messageId:'audit-pal-answer',phase:'final_answer',time:{at:Date.parse(fixture.journalClock.user)+2000,source:'journal'}},
]}}

const table='| Çalışma ortamı | Model sağlayıcısı | Başlangıç zamanı | Kullanılan araçlar | Son doğrulama | Sonuç |\n| --- | --- | --- | --- | --- | --- |\n| Yerel çalışma alanı | Önizleme sağlayıcısı | Bugünkü görüşme | Dosyalar ve kaynaklar | Okunabilirlik kontrolü | Birlikte değerlendireceğiz |'
const codeWithCrLf='const greeting = "Merhaba, Namzu!";\r\n\r\nconsole.log(greeting);\r\n'
const unclosedCode='const greeting = "Merhaba, Namzu!";\n\nconsole.log(greeting);'
function verificationFixture(scenario){
 const data=structuredClone(fixture)
 const codePayload=scenario.name.includes('wide')?codeWithCrLf:unclosedCode
 const codeMarkdown=scenario.name.includes('wide')?`\`\`\`txt\r\n${codePayload}\r\n\`\`\``:`\`\`\`txt\n${codePayload}`
 const reply=`İşte birlikte inceleyebileceğimiz kısa bir örnek.\n\n${table}\n\n\`\`\`txt\n\`\`\`\n\n${codeMarkdown}`
 data.coldHistory.messages[1]={...data.coldHistory.messages[1],text:reply,phase:'final_answer',status:'completed'}
 const turnId=data.coldHistory.work.turns[0].turnId
 const commentary={role:'assistant',text:'Önce kısa örneği hazırlıyorum, sonra birlikte bakabiliriz.',phase:'commentary',status:'completed',stopReason:'tool_use',messageId:'chat-audit-commentary',time:{at:Date.parse(data.journalClock.user)+1,source:'journal'}}
 data.coldHistory.messages.splice(1,0,commentary)
 data.coldHistory.work.messages[1].index=2
 data.coldHistory.work.messages[1].order++
 for(const tool of data.coldHistory.work.tools)tool.order++
 data.coldHistory.work.messages.push({index:1,messageId:commentary.messageId,turnId,order:4})
 data.persistenceHistories['sample-thread-7'].messages.splice(2,0,{...commentary,text:'I will prepare the example before sending it.'})
 data.persistenceHistories['sample-thread-7'].messages.at(-1).text=reply
 return {data,codePayload,reply}
}

function augmentPal({pal,speechEnabled}){
 const original=Object.getOwnPropertyDescriptor(window,'namzu')
 Object.defineProperty(window,'namzu',{configurable:true,get:original.get,set(value){
  original.set(value)
  const api=original.get()
  // Exercise the existing preview catalogue's own Pal/project/conversation creation.
  // All mutations are confined to the disposable browser sample catalogue.
  void api.createPal({name:'Kiro',appearance:{character:'pixel',color:'green'},model:{provider:'anthropic',model:'sample-balanced'}})
  void api.newConversation('project-sample-pal-1')
  api.palComputer=async()=>({status:'stopped'})
  api.hostComputer=async()=>({name:'Preview computer',platform:'other'})
  if(speechEnabled){
   const state={settings:{enabled:true,language:'tr',engine:'ema-lightning',idleUnloadSeconds:300},installation:'ready',worker:'unloaded',device:'cpu',resources:{modelDownloadBytes:34389147,runtimeDownloadBytes:null,diskBytes:null,ramBytes:null,cpuPercent:null,vramBytes:null,firstAudioMs:null,measuredAt:null}}
   api.localSpeechState=async()=>structuredClone(state)
   api.onLocalSpeechEvent=()=>()=>{}
   for(const method of ['localSpeechConfigure','localSpeechInstall','localSpeechSpeak','localSpeechCancel','localSpeechAcknowledge'])api[method]=async()=>{throw new Error('Speech/audio operation forbidden in conversation surface proof.')}
  }
  const copies=[];let copyGate
  const surfaceListeners=new Set();let surfaceRevision=1000
  const onEvent=api.onEvent
  api.onEvent=listener=>{surfaceListeners.add(listener);const unsubscribe=onEvent(listener);return()=>{surfaceListeners.delete(listener);unsubscribe()}}
  api.copyText=async text=>{copies.push(text);if(copyGate){const gate=copyGate;copyGate=undefined;await gate.promise}}
  window.__chatSurfaceProof={
   copyCalls:()=>structuredClone(copies),
   holdCopy(){let resolve,reject;copyGate={promise:new Promise((yes,no)=>{resolve=yes;reject=no}),resolve:()=>resolve(),reject:()=>reject(new Error('Synthetic clipboard unavailable'))};window.__activeCopyGate=copyGate},
   resolveCopy(){window.__activeCopyGate.resolve()},rejectCopy(){window.__activeCopyGate.reject()},
   emit(sessionId,projectId,events){for(const event of events)for(const listener of surfaceListeners)listener({...event,sessionId,projectId,revision:++surfaceRevision})},
  }
  if(pal){
   const workspace={windowId:'timing-window',sequence:0,homeGroupId:'timing-group',layout:{version:1,revision:0,windows:[{id:'timing-window',focusedGroupId:'timing-group',root:{kind:'group',id:'timing-group',tabs:['sample-thread-1','sample-thread-7'],activeTabId:'sample-thread-7'}}]}}
   api.workspace=async()=>structuredClone(workspace)
   api.workspaceAction=async action=>{const group=workspace.layout.windows[0].root;if(action.kind==='open'||action.kind==='activate'){if(!group.tabs.includes(action.tabId))group.tabs.push(action.tabId);group.activeTabId=action.tabId}workspace.sequence++;workspace.layout.revision++;return structuredClone(workspace)}
  }
 }})
}

const require=createRequire(join(repo,'packages/desktop/package.json'))
const {createServer}=await import(require.resolve('vite'))
const {chromium,expect}=require('@playwright/test')
const server=await createServer({root:join(repo,'packages/desktop'),server:{host:'127.0.0.1',port:0,hmr:false},logLevel:'error'})
await server.listen()
const origin=`http://127.0.0.1:${server.httpServer.address().port}/preview`
const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']})
const sourcePaths=['app.tsx','composer.tsx','composer.css','composer-surface.tsx','pal-chat-transcript.tsx','pal-chat-transcript.css','pal-context.tsx','pal-context.css','transcript.tsx','transcript-motion.css','style.css','message.tsx','message-footer.css','message-actions.tsx','message-actions.css','copy-button.tsx','computer-workspace-toolbar.tsx','local-speech-settings.tsx','use-local-speech.ts']
const fingerprint=()=>Promise.all(sourcePaths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(join(repo,'packages/desktop/src/renderer',path))).digest('hex')})))
const report={capturedAt:new Date().toISOString(),verification:verify,source:await fingerprint(),nativeActions:0,providerRequests:0,userDataReads:0,actualComponents:true,conditions:[],pageErrors:[],checks:[],limits:['Disposable preview sample catalogue and synthetic messages; no native data, models, or reference-app pixel-parity claim.','Screenshots show representative states only; this is not a full motion or harness matrix.','Clipboard writes are synthetic deferred promises; no OS clipboard read/write occurs.']}
try{
 for(const scenario of [
  {name:'normal-wide-dark',pal:false,appearance:'dark',viewport:{width:1280,height:900},expanded:true},
  {name:'normal-narrow-light',pal:false,appearance:'light',viewport:{width:640,height:720},expanded:false},
  {name:'pal-wide-dark',pal:true,appearance:'dark',viewport:{width:1280,height:900}},
  {name:'pal-minimum-short-light',pal:true,appearance:'light',viewport:{width:560,height:480}},
 ]){
  const context=await browser.newContext({viewport:scenario.viewport,colorScheme:scenario.appearance,reducedMotion:verify&&scenario.name.includes('wide')?'no-preference':'reduce',timezoneId:'Europe/Istanbul'})
  await context.route('**/*',route=>new URL(route.request().url()).origin===new URL(origin).origin?route.continue():route.abort())
  const page=await context.newPage();page.setDefaultTimeout(12000)
  page.on('pageerror',error=>report.pageErrors.push({scenario:scenario.name,message:error.message}))
  const inputs=verify?verificationFixture(scenario):{data:fixture}
  await page.addInitScript({content:`(${installFixture.toString()})(${JSON.stringify({fixture:inputs.data,appearance:scenario.appearance})});(${augmentPal.toString()})(${JSON.stringify({pal:scenario.pal,speechEnabled:verify})});`})
  await page.goto(origin)
  await expect(page.locator('.transcript')).toHaveAttribute('data-history-state','authoritative')
  await expect(page.locator(scenario.pal?'.pal-chat-transcript':'.normal-transcript')).toBeVisible()
  await page.evaluate(()=>document.fonts.ready)
  await page.clock.install();await page.clock.pauseAt(Date.now());await page.clock.runFor(64)
  if(scenario.expanded){await page.locator('.normal-transcript .activity-trigger').click();await page.clock.runFor(64)}
  if(scenario.name==='normal-narrow-light'){
   await page.locator('textarea').fill('Bu üç alanı birlikte gözden geçirelim.\nÖnce mesajlar, ardından yazma alanı.\nSon olarak da kısa ekranlardaki görünüm.')
   await page.clock.runFor(64)
  }
  await page.getByRole('button',{name:'Toggle sidebar',exact:true}).hover()
  await page.clock.runFor(64)
  let verification
  if(verify)verification=await verifySurface(page,scenario,inputs)
  const metrics=await page.evaluate(()=>{
   const rect=element=>{if(!element)return null;const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}}
   const selectors=['.workspace','.chat-stage','.transcript','.conversation-body','.normal-transcript','.pal-chat-transcript','.pal-context-card','.normal-composer-shell','.pal-composer-shell','textarea','.composer-context-above','.composer-footer-options','.pal-composer-send-actions']
   const boxes=Object.fromEntries(selectors.map(selector=>[selector,[...document.querySelectorAll(selector)].map(element=>{const s=getComputedStyle(element);return {rect:rect(element),clientWidth:element.clientWidth,scrollWidth:element.scrollWidth,clientHeight:element.clientHeight,scrollHeight:element.scrollHeight,fontSize:s.fontSize,lineHeight:s.lineHeight,padding:s.padding,gap:s.gap,overflowX:s.overflowX,overflowY:s.overflowY,display:s.display}})]))
  const controls=[...document.querySelectorAll('.normal-composer-shell button,.pal-composer-shell button,.pal-context-card button,.conversation-tab-actions button')].filter(element=>element.checkVisibility({opacityProperty:true,visibilityProperty:true})).map(element=>({label:element.getAttribute('aria-label')??element.textContent.trim(),title:element.getAttribute('title'),disabled:element.disabled,rect:rect(element),fontSize:getComputedStyle(element).fontSize,color:getComputedStyle(element).color}))
   const voiceControl=document.querySelector('button[aria-label="Voice settings"]')
   const composerVoice=voiceControl?{button:rect(voiceControl),children:[...voiceControl.children].map(child=>({tag:child.tagName,text:child.textContent,rect:rect(child)})),clientWidth:voiceControl.clientWidth,scrollWidth:voiceControl.scrollWidth,send:rect(document.querySelector('button[aria-label="Send message"]'))}:null
   const messageMetrics=[...document.querySelectorAll('.message')].map(element=>({role:element.dataset.role??(element.classList.contains('user')?'user':'assistant'),rect:rect(element),bubble:rect(element.querySelector('.pal-chat-bubble')??element.querySelector('.message-content')),text:[...element.querySelectorAll('.message-text')].map(child=>({rect:rect(child),fontSize:getComputedStyle(child).fontSize,lineHeight:getComputedStyle(child).lineHeight,color:getComputedStyle(child).color})),clock:rect(element.querySelector('.message-time'))}))
   const overflow=[...document.querySelectorAll('.conversation-body *,.normal-composer-shell *,.pal-composer-shell *,.pal-context-card *')].filter(element=>{const r=element.getBoundingClientRect();const s=getComputedStyle(element);return element.checkVisibility({opacityProperty:true,visibilityProperty:true})&&r.width>0&&r.height>0&&(r.right>innerWidth+.5||r.left<-.5||element.clientWidth>0&&element.scrollWidth>element.clientWidth+1&&['visible','clip'].includes(s.overflowX))}).map(element=>({tag:element.tagName,className:typeof element.className==='string'?element.className:'svg',rect:rect(element),clientWidth:element.clientWidth,scrollWidth:element.scrollWidth,overflowX:getComputedStyle(element).overflowX}))
   return {viewport:{width:innerWidth,height:innerHeight},body:{clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth},boxes,controls,composerVoice,messages:messageMetrics,overflow,historyCalls:window.__timingProof.calls().histories}
  })
  const filename=`${verify?'verified-':''}${scenario.name}.png`;await page.screenshot({path:join(artifacts,filename)})
  if(verify){
   const voice=metrics.composerVoice
   assert.ok(voice,'The enabled voice setting is rendered in the composer.')
   for(const child of voice.children)assert.ok(child.rect.x>=voice.button.x-.5&&child.rect.right<=voice.button.right+.5,'The enabled language label/icon stay inside Voice settings.')
   assert.ok(voice.button.right<=voice.send.x+.5,'Voice settings does not overlap Send.')
   verification.composerVoice={...voice,childrenContained:true,sendDoesNotOverlap:true}
  }
  report.conditions.push({...scenario,metrics,verification,screenshot:filename,screenshotSha256:createHash('sha256').update(await readFile(join(artifacts,filename))).digest('hex')})
  await context.close()
 }
 report.sourceAfter=await fingerprint();report.sourceStayedFixed=JSON.stringify(report.source)===JSON.stringify(report.sourceAfter)
 if(verify){assert.deepEqual(report.pageErrors,[]);assert.equal(report.sourceStayedFixed,true,'Final source changed during the focused proof.');report.passed=true}
}finally{await browser.close();await server.close();await writeFile(join(artifacts,verify?'verification.json':'audit.json'),JSON.stringify(report,null,2)+'\n')}
console.log(JSON.stringify({screenshots:report.conditions.length,pageErrors:report.pageErrors.length,sourceStayedFixed:report.sourceStayedFixed}))

async function settle(page){await page.evaluate(()=>{for(const animation of document.getAnimations())if(Number.isFinite(animation.effect?.getComputedTiming().endTime)){try{animation.finish()}catch{}}});await page.clock.runFor(64)}
async function verifySurface(page,scenario,inputs){
 const verified={copy:{},table:{},pal:{}}
 const replyButtons=page.getByRole('button',{name:'Copy reply',exact:true})
 assert.equal(await page.locator('[data-message-role="user"] .message-actions,[data-message-phase="commentary"] .message-actions').count(),0,'Only assistant replies expose reply actions.')
 assert.equal(await replyButtons.count(),scenario.pal?2:1,'Delivered assistant replies have exactly one reply copy action.')
 const codeButtons=page.getByRole('button',{name:'Copy code',exact:true})
 assert.equal(await codeButtons.count(),2)
 const emptyCode=codeButtons.first()
 assert.equal(await emptyCode.isDisabled(),true,'An empty parsed code block cannot write the clipboard.')
 await emptyCode.evaluate(element=>element.click())
 assert.deepEqual(await page.evaluate(()=>window.__chatSurfaceProof.copyCalls()),[])
 const codeButton=codeButtons.last()
 await codeButton.scrollIntoViewIfNeeded();await settle(page)
 await page.evaluate(()=>window.__chatSurfaceProof.holdCopy())
 await codeButton.click();await settle(page)
 await expect(codeButton).toHaveAttribute('data-copy-state','pending')
 assert.equal(await codeButton.isDisabled(),true)
 assert.equal((await page.evaluate(()=>window.__chatSurfaceProof.copyCalls())).at(-1),inputs.codePayload)
 await page.evaluate(()=>window.__chatSurfaceProof.rejectCopy());await settle(page)
 await expect(codeButton).toHaveAttribute('data-copy-state','error')
 assert.equal(await codeButton.isDisabled(),false)
 await page.evaluate(()=>window.__chatSurfaceProof.holdCopy())
 await codeButton.click();await settle(page)
 await expect(codeButton).toHaveAttribute('data-copy-state','pending')
 await page.evaluate(()=>window.__chatSurfaceProof.resolveCopy());await settle(page)
 await expect(codeButton).toHaveAttribute('data-copy-state','copied')
 const copies=await page.evaluate(()=>window.__chatSurfaceProof.copyCalls())
 assert.deepEqual(copies,[inputs.codePayload,inputs.codePayload])
 const replyButton=replyButtons.last()
 await replyButton.scrollIntoViewIfNeeded();await settle(page)
 await replyButton.click();await settle(page)
 assert.equal((await page.evaluate(()=>window.__chatSurfaceProof.copyCalls())).at(-1),inputs.reply,'Reply copy preserves literal complete Markdown text.')
 verified.copy={codePayload:inputs.codePayload,replyPayloadSha256:createHash('sha256').update(inputs.reply).digest('hex'),attempts:3,asyncRejectionRetry:true,successAfterResolution:true,emptyCodeDisabled:true}
 const message=replyButton.locator('xpath=ancestor::*[@data-message-role][1]')
 const geometry=()=>message.evaluate(element=>{const r=node=>{const box=node?.getBoundingClientRect();return box&&{x:box.x,y:box.y,width:box.width,height:box.height}};const transcript=element.closest('.transcript');return {row:r(element),actions:r(element.querySelector('.message-actions')),clock:r(element.querySelector('.message-time')),parent:r(element.parentElement),next:r(element.nextElementSibling),scrollTop:transcript.scrollTop,scrollHeight:transcript.scrollHeight}})
 await page.clock.runFor(2001);await settle(page)
 await page.getByRole('button',{name:'Toggle sidebar',exact:true}).hover();await page.getByRole('button',{name:'Toggle sidebar',exact:true}).focus();await settle(page)
 // Hover the visible action row, which also hovers the containing message.
 // Hovering a partially clipped long message itself makes Playwright scroll it.
 const rest=await geometry()
 const footer=message.locator('.message-footer')
 assert.equal(await footer.evaluate(element=>getComputedStyle(element).opacity),'0','Idle footer reveals only through hover/focus.')
 const actionBox=await message.locator('.message-actions').boundingBox()
 await page.mouse.move(actionBox.x+actionBox.width/2,actionBox.y+actionBox.height/2)
 await page.clock.runFor(32)
 const hoverSamples=[]
 for(const fraction of [0,.5,1]){
  const motion=await footer.evaluate((element,fraction)=>{const animations=element.getAnimations().map(animation=>{const timing=animation.effect?.getComputedTiming();if(timing&&Number.isFinite(timing.endTime)){animation.pause();animation.currentTime=timing.endTime*fraction}return {property:animation.transitionProperty,duration:timing?.duration}});return {opacity:getComputedStyle(element).opacity,animations}},fraction)
  const sample=await geometry();assert.deepEqual(sample,rest,'Footer reveal preserves exact geometry at each actual animation fraction.')
  hoverSamples.push({fraction,...motion,geometry:sample})
 }
 const hovered=await geometry()
 assert.deepEqual(hovered,rest,'Reply hover only changes visibility/treatment, not layout.')
 assert.equal(hoverSamples.at(-1).opacity,'1')
 if(scenario.name.includes('wide')){assert.equal(hoverSamples[0].opacity,'0');assert.ok(Number(hoverSamples[1].opacity)>0&&Number(hoverSamples[1].opacity)<1);assert.ok(hoverSamples[0].animations.some(animation=>animation.property==='opacity'&&animation.duration===160))}
 await settle(page)
 await page.getByRole('button',{name:'Toggle sidebar',exact:true}).hover();await settle(page)
 assert.deepEqual(await geometry(),rest)
 assert.equal(await footer.evaluate(element=>getComputedStyle(element).opacity),'0')
 await page.keyboard.press('Tab');await page.getByRole('button',{name:'Toggle sidebar',exact:true}).focus()
 await footer.getByRole('button',{name:'Read aloud',exact:true}).focus();await settle(page)
 assert.equal(await footer.evaluate(element=>getComputedStyle(element).opacity),'1')
 assert.deepEqual(await geometry(),rest,'Keyboard footer reveal preserves geometry.')
 verified.copy.hoverGeometry=rest
 verified.copy.footerVisibility={rest:'0',hoverSamples,leave:'0',keyboardFocus:'1',speechOperations:0}
 verified.footer=await message.locator('.message-footer').evaluate(element=>{
  const rect=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,centerY:r.y+r.height/2,right:r.right}}
  const clock=element.querySelector('.message-time')
  const voice=element.querySelector('button[aria-label="Read aloud"]')
  const copy=element.querySelector('button[aria-label="Copy reply"]')
  if(!clock||!voice||!copy)throw new Error('The enabled-voice reply must have clock, voice and copy in its shared footer.')
  return {footer:rect(element),clock:rect(clock),voice:rect(voice),copy:rect(copy),elementsShareFooter:clock.closest('.message-footer')===voice.closest('.message-footer')&&voice.closest('.message-footer')===copy.closest('.message-footer')}
 })
 assert.equal(verified.footer.elementsShareFooter,true)
 assert.ok(Math.abs(verified.footer.clock.centerY-verified.footer.voice.centerY)<.51,'Clock and voice are aligned in one footer row.')
 assert.ok(Math.abs(verified.footer.clock.centerY-verified.footer.copy.centerY)<.51,'Clock and copy are aligned in one footer row.')
 const table=page.getByRole('region',{name:'Table',exact:true}).last()
 await table.scrollIntoViewIfNeeded();await table.focus();await settle(page)
 await expect(table).toHaveAttribute('tabindex','0')
 const tableGeometry=()=>table.evaluate(element=>{const r=element.getBoundingClientRect();const parent=element.closest('.message-text').getBoundingClientRect();return {x:r.x,width:r.width,right:r.right,parentRight:parent.right,clientWidth:element.clientWidth,scrollWidth:element.scrollWidth,scrollLeft:element.scrollLeft,documentWidth:document.documentElement.scrollWidth,viewport:innerWidth,overflowX:getComputedStyle(element).overflowX,role:element.getAttribute('role'),label:element.getAttribute('aria-label')}})
 const before=await tableGeometry()
 assert.equal(before.overflowX,'auto')
 assert.ok(before.scrollWidth>before.clientWidth,'The fixture must actually overflow within the table.')
 assert.ok(before.right<=before.parentRight+.5)
 assert.equal(before.documentWidth,before.viewport)
 await table.evaluate(element=>{window.__tableScrollEnd=new Promise(resolve=>element.addEventListener('scrollend',event=>resolve({trusted:event.isTrusted,scrollLeft:element.scrollLeft}),{once:true}))})
 await page.keyboard.press('ArrowRight')
 const scrollEvent=await page.evaluate(()=>window.__tableScrollEnd)
 const after=await tableGeometry()
 assert.equal(scrollEvent.trusted,true);assert.ok(after.scrollLeft>before.scrollLeft)
 assert.equal(after.documentWidth,before.documentWidth);assert.equal(after.right,before.right)
 verified.table={before,after,scrollEvent}
 if(scenario.name==='normal-wide-dark')verified.streaming=await verifyStreamingReply(page)
 if(scenario.pal){
 assert.equal(await page.locator('.pal-context-section[aria-label="Recent activity"],.pal-context-section[aria-label="Outputs"]').count(),0,'Empty profile sections stay absent.')
  if(scenario.name.includes('minimum')){
   verified.pal=await verifyCompactPal(page)
   verified.streaming=await verifyMinimumPalStreamingReply(page)
  }else{
   await expect(page.locator('.pal-context-card')).toHaveAttribute('data-compact','false')
   verified.pal.card=await page.locator('.pal-context-card').boundingBox()
  }
 }
 if(scenario.name.includes('minimum')){await page.keyboard.press('Escape');await settle(page)}
 const finalVoice=page.getByRole('button',{name:'Read aloud',exact:true}).last()
 await finalVoice.scrollIntoViewIfNeeded();await settle(page)
 const voiceBox=await finalVoice.boundingBox();await page.getByRole('button',{name:'Toggle sidebar',exact:true}).focus();await page.mouse.move(voiceBox.x+voiceBox.width/2,voiceBox.y+voiceBox.height/2);await settle(page)
 report.checks.push(`${scenario.name}: local keyboard-scrollable table; exact parsed code/literal reply copy with asynchronous rejection and retry; settled-only reply action and fixed hover geometry${scenario.pal?'; responsive Pal context':''}.`)
 return verified
}

async function verifyStreamingReply(page){
 await page.getByRole('tab',{name:'Namzu: Review message settings',exact:true}).click();await settle(page)
 await expect(page.locator('.transcript')).toHaveAttribute('data-history-state','authoritative')
 const at=Date.parse(fixture.journalClock.user)
 await page.evaluate(at=>window.__chatSurfaceProof.emit('sample-thread-3','sample-app',[
  {kind:'prompt',prompt:'Show a short example in this synthetic conversation.',at},
  {kind:'state',running:true,queued:[],at},
  {kind:'update',at:at+1,update:{kind:'agent_message_chunk',messageId:'surface-stream-final',phase:'final_answer',text:'A short answer is arriving.'}},
 ]),at)
 await settle(page)
 await expect(page.getByText('A short answer is arriving.',{exact:true})).toBeVisible()
 assert.equal(await page.getByRole('button',{name:'Copy reply',exact:true}).count(),0,'Streaming partial final text has no settled reply action.')
 const during=await page.locator('.normal-transcript').evaluate(element=>({replyActions:element.querySelectorAll('.message-actions').length,phase:element.querySelector('.working')?.dataset.transcriptPhase??null}))
 const footerGeometry=()=>page.locator('.normal-transcript [data-message-phase="final_answer"] .message-footer').last().evaluate(element=>({height:element.getBoundingClientRect().height,clockKnown:!!element.querySelector('.message-time time'),replyActions:element.querySelectorAll('.message-actions').length}))
 const liveFooter=await footerGeometry()
 assert.equal(liveFooter.clockKnown,true,'The live fixture has a known host timestamp.')
 assert.equal(liveFooter.height,24,'A known clock reserves the same desktop footer height before reply actions exist.')
 await page.evaluate(at=>window.__chatSurfaceProof.emit('sample-thread-3','sample-app',[
  {kind:'update',at:at+2,update:{kind:'agent_message',messageId:'surface-stream-final',phase:'final_answer',content:'A short answer is ready.',status:'completed',stopReason:'end_turn'}},
  {kind:'update',at:at+2,update:{kind:'turn_ended',stopReason:'end_turn'}},
  {kind:'state',running:false,queued:[],at:at+2},
 ]),at)
 await settle(page)
 await expect(page.getByRole('button',{name:'Copy reply',exact:true})).toHaveCount(1)
 const settledFooter=await footerGeometry()
 assert.equal(settledFooter.height,24)
 assert.equal(settledFooter.height,liveFooter.height,'Settling a known-clock reply does not grow the footer row.')
 await page.getByRole('tab',{name:'Namzu: Refine navigation',exact:true}).click();await settle(page)
 return {during,liveFooter,settledFooter,settledReplyActions:1,providerRequests:0,source:'Synthetic public ACP events into actual App projection'}
}

async function verifyMinimumPalStreamingReply(page){
 // A second disposable page keeps the representative screenshot on the original
 // delivered reply while testing actual App live→settled projection separately.
 const livePage=await page.context().newPage()
 livePage.setDefaultTimeout(12000)
 livePage.on('pageerror',error=>report.pageErrors.push({scenario:'pal-minimum-live-settled',message:error.message}))
 try{
  const data=verificationFixture({name:'pal-minimum-short-light'}).data
  await livePage.addInitScript({content:`(${installFixture.toString()})(${JSON.stringify({fixture:data,appearance:'light'})});(${augmentPal.toString()})(${JSON.stringify({pal:true,speechEnabled:true})});`})
  await livePage.goto(page.url())
  await expect(livePage.locator('.transcript')).toHaveAttribute('data-history-state','authoritative')
  await expect(livePage.locator('.pal-chat-transcript')).toBeVisible()
  await livePage.evaluate(()=>document.fonts.ready)
  await livePage.clock.install();await livePage.clock.pauseAt(Date.now());await livePage.clock.runFor(64)
  const at=Date.parse(fixture.journalClock.user)
  await livePage.evaluate(at=>window.__chatSurfaceProof.emit('sample-thread-7','project-sample-pal-1',[
   {kind:'prompt',prompt:'Show a short Pal reply in this synthetic conversation.',at},
   {kind:'state',running:true,queued:[],at},
   {kind:'update',at:at+1,update:{kind:'agent_message_chunk',messageId:'surface-pal-stream-final',phase:'final_answer',text:'A short Pal reply is arriving.'}},
  ]),at)
  await settle(livePage)
  assert.equal(await livePage.getByText('A short Pal reply is arriving.',{exact:true}).count(),0,'Pal delivery keeps provisional chunks hidden and shows concise typing state.')
  await livePage.evaluate(at=>window.__chatSurfaceProof.emit('sample-thread-7','project-sample-pal-1',[
   {kind:'update',at:at+2,update:{kind:'agent_message',messageId:'surface-pal-stream-final',phase:'final_answer',content:'A short Pal reply is ready.',status:'completed',stopReason:'end_turn'}},
  ]),at)
  await settle(livePage)
  await expect(livePage.getByText('A short Pal reply is ready.',{exact:true})).toBeVisible()
  const footerGeometry=()=>livePage.locator('.pal-chat-message[data-message-phase="final_answer"] .message-footer').last().evaluate(element=>({height:element.getBoundingClientRect().height,clockKnown:!!element.querySelector('.message-time time'),replyActions:element.querySelectorAll('.message-actions').length}))
  const liveFooter=await footerGeometry()
  assert.equal(liveFooter.clockKnown,true)
  assert.equal(liveFooter.replyActions,0,'The live Pal reply has no settled actions.')
  assert.equal(liveFooter.height,28,'The minimum-width known clock reserves its eventual action height.')
  await livePage.evaluate(at=>window.__chatSurfaceProof.emit('sample-thread-7','project-sample-pal-1',[
   {kind:'update',at:at+3,update:{kind:'turn_ended',stopReason:'end_turn'}},
   {kind:'state',running:false,queued:[],at:at+3},
  ]),at)
  await settle(livePage)
  const settledReply=livePage.getByText('A short Pal reply is ready.',{exact:true}).locator('xpath=ancestor::*[@data-message-role][1]')
  await expect(settledReply.getByRole('button',{name:'Copy reply',exact:true})).toHaveCount(1)
  const settledFooter=await footerGeometry()
  assert.equal(settledFooter.height,28)
  assert.equal(settledFooter.height,liveFooter.height,'Settling a known-clock Pal reply does not grow its footer.')
  return {liveFooter,settledFooter,provisionalPalChunkHidden:true,liveBoundary:'Completed assistant message delivered during an otherwise running turn',providerRequests:0,source:'Synthetic public ACP events into actual App projection, separate disposable minimum-width Pal page'}
 }finally{await livePage.close()}
}

async function verifyCompactPal(page){
 const verified={sizes:[],dialogs:[]}
 for(const viewport of [{width:560,height:480},{width:640,height:720},{width:900,height:720}]){
  await page.setViewportSize(viewport);await settle(page)
  if(viewport.width===900){await page.getByRole('button',{name:'Toggle sidebar',exact:true}).click();await settle(page)}
  const card=page.locator('.pal-context-card')
  await expect(card).toHaveAttribute('data-compact','true')
  const trigger=page.locator('.pal-context-compact-trigger')
  await trigger.click();await settle(page)
  const popup=page.locator('.pal-context-popup')
  await expect(popup).toBeVisible()
  const bounds=await popup.boundingBox()
  assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=viewport.width+.5&&bounds.y+bounds.height<=viewport.height+.5,'Pal popover stays within its viewport.')
  assert.equal(await page.locator('.pal-context-body').count(),1,'Only one full Pal body is mounted.')
  verified.sizes.push({viewport,popup:bounds,stage:await page.locator('.chat-stage').boundingBox(),card:await card.boundingBox(),composer:await page.locator('.pal-composer-shell').boundingBox(),textarea:await page.locator('textarea').boundingBox()})
  await page.keyboard.press('Escape');await settle(page)
  await expect(popup).toHaveCount(0)
  assert.equal(await trigger.evaluate(element=>element===document.activeElement),true,'Escape returns focus to the compact trigger.')
  await trigger.click();await settle(page)
  // Preview badge deliberately ignores pointer events; click harmless titlebar
  // background instead, producing an actual outside pointer event.
  await page.mouse.click(viewport.width-18,16);await settle(page)
  await expect(popup).toHaveCount(0)
  if(viewport.width===900){await page.getByRole('button',{name:'Toggle sidebar',exact:true}).click();await settle(page)}
 }
 await page.setViewportSize({width:560,height:480});await settle(page)
 const trigger=page.locator('.pal-context-compact-trigger')
 for(const label of ['Kiro settings','Customize Kiro']){
  await trigger.click();await settle(page)
  await page.getByRole('button',{name:label,exact:true}).click();await settle(page)
  await expect(page.locator('.pal-context-popup')).toHaveCount(0)
  const dialog=page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  assert.equal(await dialog.evaluate(element=>element.contains(document.activeElement)),true,'The opened Pal dialog has usable focus.')
  verified.dialogs.push({label,rect:await dialog.boundingBox()})
  await page.keyboard.press('Escape');await settle(page)
  await expect(dialog).toHaveCount(0)
 }
 await trigger.click();await settle(page)
 const start=page.getByRole('button',{name:'Start computer',exact:true})
 await start.focus();await settle(page)
 assert.equal(await start.locator('.pal-status-hover').evaluate(element=>getComputedStyle(element).opacity),'1')
 verified.computerAction='Offline status exposes Start computer on focus; never invoked.'
 return verified
}
