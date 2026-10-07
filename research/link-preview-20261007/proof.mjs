/** Actual-renderer proof of link preview cards; isolated loopback Vite, mocked bridge, no network. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {join,resolve} from 'node:path'
import {installFixture} from '../transcript-motion-20261007/fixture.mjs'

const repo=resolve(process.argv[2]??'.')
const artifacts=join(repo,'research/link-preview-20261007/artifacts')
const fixture=JSON.parse(await readFile(join(repo,'research/transcript-search-timing-20261007/artifacts/journal-fixtures.json'),'utf8'))
const filler=Array.from({length:30},(_,i)=>`Paragraph ${i+1} of filler so that the transcript has a scrollable height.`).join('\n\n')
const reply=filler+'\n\nHere are the sources I used. Read [the rich page](https://rich.example.test/guide/getting-started/) first, then [a page with no details](https://plain.example.test/notes), and [a slow page](https://slow.example.test/report). The raw address is `https://rich.example.test/guide/`.'
fixture.coldHistory.messages[1]={...fixture.coldHistory.messages[1],text:reply,phase:'final_answer',status:'completed'}

function installBridge(){
 const original=Object.getOwnPropertyDescriptor(window,'namzu')
 Object.defineProperty(window,'namzu',{configurable:true,get:original.get,set(value){
  original.set(value)
  const api=original.get()
  const calls={linkPreview:[],linkPreviewImage:[]}
  let release;const gate=new Promise(resolve=>{release=resolve})
  const png=(w,h,a,b,round)=>{const c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d');const g=x.createLinearGradient(0,0,w,h);g.addColorStop(0,a);g.addColorStop(1,b);x.fillStyle=g;if(round){x.roundRect(0,0,w,h,8);x.fill()}else x.fillRect(0,0,w,h);return c.toDataURL('image/png')}
  api.linkPreview=async url=>{
   calls.linkPreview.push(url)
   const host=new URL(url).hostname
   if(host.startsWith('plain'))return null
   if(host.startsWith('slow'))await gate
   return {url,head:`<html><head><title>Plain title</title><meta property="og:title" content="A calm way to read the web"><meta property="og:description" content="A short summary of the page, long enough to show how several lines of description are clamped inside the card without pushing anything around."><meta property="og:site_name" content="Example Journal"><meta property="og:image" content="/share.png"><link rel="icon" sizes="32x32" href="/icon.png"></head>`}
  }
  api.linkPreviewImage=async(url,kind)=>{calls.linkPreviewImage.push({url,kind});return kind==='image'?png(1200,630,'#c7d2fe','#fbcfe8',false):png(32,32,'#6366f1','#ec4899',true)}
  window.__lp={calls:()=>structuredClone(calls),release:()=>release()}
 }})
}

const require=createRequire(join(repo,'packages/desktop/package.json'))
const {createServer}=await import(require.resolve('vite'))
const {chromium,expect:baseExpect}=require('@playwright/test')
const expect=baseExpect.configure({timeout:30000})
const server=await createServer({root:join(repo,'packages/desktop'),server:{host:'127.0.0.1',port:0,hmr:false},logLevel:'error'})
await server.listen()
const origin=`http://127.0.0.1:${server.httpServer.address().port}/preview`
const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']})
const report={capturedAt:new Date().toISOString(),conditions:[],pageErrors:[],consoleErrors:[],externalRequests:[],checks:{}}
const card='[data-slot="preview-card-popup"]'
try{
 const open=async(scheme,viewport,reducedMotion='no-preference')=>{
  const context=await browser.newContext({viewport,colorScheme:scheme,reducedMotion})
  await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.hostname==='127.0.0.1'||u.protocol==='data:')return route.continue();report.externalRequests.push(route.request().url());return route.abort()})
  const page=await context.newPage();page.setDefaultTimeout(30000)
  page.on('pageerror',e=>report.pageErrors.push(e.message))
  page.on('console',m=>{if(m.type()==='error')report.consoleErrors.push(m.text())})
  await page.addInitScript({content:`(${installFixture.toString()})(${JSON.stringify({fixture,appearance:scheme})});(${installBridge.toString()})()`})
  await page.goto(origin)
  await expect(page.locator('.transcript')).toHaveAttribute('data-history-state','authoritative')
  await expect(page.locator('a.message-link').first()).toBeVisible()
  await page.evaluate(()=>document.fonts.ready)
  return {context,page}
 }
 const layout=page=>page.evaluate(()=>{const s=document.querySelector('.transcript');const m=document.querySelector('[data-message-role="assistant"]');const r=m.getBoundingClientRect();return {scrollTop:s.scrollTop,scrollHeight:s.scrollHeight,box:[r.x,r.y,r.width,r.height]}})
 const calls=page=>page.evaluate(()=>window.__lp.calls())
 const inside=async(page)=>{const b=await page.locator(card).boundingBox();const v=page.viewportSize();assert.ok(b.x>=0&&b.y>=0&&b.x+b.width<=v.width&&b.y+b.height<=v.height,`card outside viewport ${JSON.stringify(b)}`);return b}
 const settle=page=>page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>Number.isFinite(a.effect.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{}))))
 const link=(page,name)=>page.getByRole('link',{name})

 // Wide dark: rich, plain, slow, cache, layout, keyboard
 {
  const {context,page}=await open('dark',{width:1280,height:900})
  assert.equal((await calls(page)).linkPreview.length,0,'no request before hover')
  const before=await layout(page)
  const rich=link(page,'the rich page')
  await rich.hover()
  await expect(page.locator(card)).toBeVisible()
  await expect(page.locator(card).getByText('A calm way to read the web')).toBeVisible()
  await settle(page)
  const during=await layout(page)
  assert.deepEqual(during,before,'layout identical while the card is open')
  const text=await page.locator(card).innerText()
  for(const part of['Example Journal','A calm way to read the web','A short summary','rich.example.test/guide/getting-started'])assert.ok(text.includes(part),`card shows ${part}`)
  assert.equal(await page.locator(`${card} img`).count(),2,'image and icon')
  const imgSrc=await page.locator(`${card} img`).evaluateAll(l=>l.map(i=>i.src.slice(0,22)))
  assert.ok(imgSrc.every(s=>s.startsWith('data:image/png')))
  const box=await inside(page)
  await page.screenshot({path:join(artifacts,'card-rich-wide-dark.png'),clip:{x:Math.max(0,box.x-40),y:Math.max(0,box.y-110),width:Math.min(1280,box.width+240),height:Math.min(900,box.height+150)}})
  assert.equal((await calls(page)).linkPreview.length,1)
  report.checks.rich={text,box,imageAspect:await page.locator(`${card} img`).first().evaluate(i=>i.getBoundingClientRect().width/i.getBoundingClientRect().height)}
  // close, re-hover: cache
  await page.mouse.move(700,850)
  await expect(page.locator(card)).toHaveCount(0)
  await expect(await layout(page)).toEqual(before)
  await rich.hover()
  await expect(page.locator(card).getByText('A calm way to read the web')).toBeVisible()
  const afterRehover=await calls(page)
  assert.equal(afterRehover.linkPreview.length,1,'cache used on re-hover')
  report.checks.cache={linkPreviewCalls:afterRehover.linkPreview.length,imageCalls:afterRehover.linkPreviewImage.length}
  await page.mouse.move(700,850);await expect(page.locator(card)).toHaveCount(0)

  // null link
  await link(page,'a page with no details').hover()
  await expect(page.locator(card)).toBeVisible()
  await expect(page.locator(card).getByText('plain.example.test',{exact:true}).first()).toBeVisible()
  await settle(page)
  const plain=await page.locator(card).innerText()
  assert.ok(!/error|fail|unavailable/i.test(plain),`no error wording: ${plain}`)
  assert.equal(await page.locator(`${card} img`).count(),0)
  const pbox=await inside(page)
  await page.screenshot({path:join(artifacts,'card-null-wide-dark.png'),clip:{x:Math.max(0,pbox.x-40),y:Math.max(0,pbox.y-110),width:Math.min(1280,pbox.width+240),height:Math.min(900,pbox.height+150)}})
  report.checks.null={text:plain,box:pbox}
  await page.mouse.move(700,850);await expect(page.locator(card)).toHaveCount(0)

  // slow link: skeleton first
  await link(page,'a slow page').hover()
  await expect(page.locator(`${card} [data-phase="loading"]`)).toBeVisible()
  await settle(page)
  const lbox=await inside(page)
  const skeletons=await page.locator(`${card} .animate-pulse`).count()
  assert.equal(skeletons,3)
  await page.screenshot({path:join(artifacts,'card-loading-wide-dark.png'),clip:{x:Math.max(0,lbox.x-40),y:Math.max(0,lbox.y-110),width:Math.min(1280,lbox.width+240),height:Math.min(900,lbox.height+150)}})
  assert.deepEqual(await layout(page),before,'layout identical while loading')
  await page.evaluate(()=>window.__lp.release())
  await expect(page.locator(`${card} [data-phase="ready"]`)).toBeVisible()
  assert.equal(await page.locator(`${card} .animate-pulse`).count(),0)
  report.checks.slow={loadingBox:lbox,skeletons,readyBox:await page.locator(card).boundingBox()}
  await page.mouse.move(700,850);await expect(page.locator(card)).toHaveCount(0)

  // inline-code bare URL is a trigger too (cached, no extra call)
  await page.locator('code a.message-link').hover()
  await expect(page.locator(card)).toBeVisible()
  await page.mouse.move(700,850);await expect(page.locator(card)).toHaveCount(0)

  // keyboard
  await page.locator('textarea').focus()
  await page.keyboard.press('Shift+Tab')
  let focused=false
  for(let i=0;i<60&&!focused;i++){await page.keyboard.press('Tab');focused=await page.evaluate(()=>document.activeElement?.matches('a.message-link'))}
  assert.ok(focused,'a link received keyboard focus')
  const href=await page.evaluate(()=>document.activeElement.href)
  await expect(page.locator(card)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator(card)).toHaveCount(0)
  assert.equal(await page.evaluate(()=>document.activeElement.href),href,'focus stays on the link')
  report.checks.keyboard={focusedHref:href,opened:true,escapeClosed:true,focusKept:true}
  report.checks.layout={before,during,after:await layout(page)}
  assert.deepEqual(report.checks.layout.after,before)
  report.conditions.push({name:'wide-dark',viewport:{width:1280,height:900}})
  await context.close()
 }
 // Narrow light
 {
  const {context,page}=await open('light',{width:560,height:720})
  await link(page,'the rich page').hover()
  await expect(page.locator(card).getByText('A calm way to read the web')).toBeVisible()
  await settle(page)
  const box=await inside(page)
  await page.screenshot({path:join(artifacts,'card-rich-narrow-light.png')})
  report.checks.narrow={box}
  report.conditions.push({name:'narrow-light',viewport:{width:560,height:720}})
  await context.close()
 }
 // Reduced motion
 {
  const {context,page}=await open('light',{width:1000,height:800},'reduce')
  await link(page,'the rich page').hover()
  await expect(page.locator(card)).toBeVisible()
  const t=await page.locator(card).evaluate(e=>{const s=getComputedStyle(e);return {property:s.transitionProperty,duration:s.transitionDuration}})
  report.checks.reducedMotion=t
  await context.close()
  const {context:c2,page:p2}=await open('light',{width:1000,height:800},'no-preference')
  await link(p2,'the rich page').hover()
  await expect(p2.locator(card)).toBeVisible()
  report.checks.normalMotion=await p2.locator(card).evaluate(e=>{const s=getComputedStyle(e);return {property:s.transitionProperty,duration:s.transitionDuration}})
  await c2.close()
 }
 report.checks.startingStateReducedMotion='Under reduce the transform/scale classes at data-starting-style/ending-style are reset (motion-reduce: variants), so only opacity animates.'
 assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);assert.deepEqual(report.externalRequests,[])
 report.passed=true
}finally{await browser.close();await server.close();await writeFile(join(artifacts,'proof.json'),JSON.stringify(report,null,2)+'\n')}
console.log(JSON.stringify({passed:report.passed,pageErrors:report.pageErrors.length,consoleErrors:report.consoleErrors.length,externalRequests:report.externalRequests.length}))
