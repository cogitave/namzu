/** Actual-renderer proof for composer paste and focus fixes; isolated loopback preview, no native or provider calls. */
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {join,resolve} from 'node:path'
import {installFixture} from '../transcript-motion-20261007/fixture.mjs'

const repo=resolve(process.argv[2]??'.')
const out=join(repo,'research/composer-fixes-20261007/artifacts')
const fixture=JSON.parse(await readFile(join(repo,'research/transcript-search-timing-20261007/artifacts/journal-fixtures.json'),'utf8'))
const require=createRequire(join(repo,'packages/desktop/package.json'))
const {createServer}=await import(require.resolve('vite'))
const {chromium,expect}=require('@playwright/test')
const server=await createServer({root:join(repo,'packages/desktop'),server:{host:'127.0.0.1',port:0,hmr:false},logLevel:'error'})
await server.listen()
const origin=`http://127.0.0.1:${server.httpServer.address().port}/preview`
const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']})
// The preview refuses device files; keep attachments in memory so the real composer can be exercised.
function memoryAttachments(){
 const original=Object.getOwnPropertyDescriptor(window,'namzu')
 Object.defineProperty(window,'namzu',{configurable:true,get:original.get,set(value){
  original.set(value)
  const api=original.get();const files=new Map()
  const key=o=>o.replace(/:workspace:.*$/,'');const list=o=>files.get(key(o))??[]
  api.addAttachments=async(owner,uploads)=>{const next=[...list(owner),...uploads.map((u,i)=>({id:`att-${performance.now()}-${i}-${list(owner).length}`,name:u.name||`pasted-${i}.png`,kind:'image',size:u.bytes.length,mediaType:'image/png'}))];files.set(key(owner),next);return structuredClone(next)}
  api.attachments=async owner=>structuredClone(list(owner))
  api.removeAttachment=async(owner,id)=>{files.set(key(owner),list(owner).filter(f=>f.id!==id))}
 }})
}
const report={capturedAt:new Date().toISOString(),pageErrors:[],checks:[]}
const check=(name,ok,detail)=>{report.checks.push({name,ok,detail});assert.ok(ok,`${name}: ${JSON.stringify(detail)}`)}
try{
 const context=await browser.newContext({viewport:{width:1100,height:800},colorScheme:'light',reducedMotion:'reduce'})
 await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:new URL(origin).origin})
 await context.route('**/*',route=>new URL(route.request().url()).origin===new URL(origin).origin?route.continue():route.abort())
 const page=await context.newPage();page.setDefaultTimeout(12000)
 page.on('pageerror',error=>report.pageErrors.push(error.message))
 await page.addInitScript({content:`(${installFixture.toString()})(${JSON.stringify({fixture,appearance:'light'})});(${memoryAttachments.toString()})()`})
 await page.goto(origin)
 await page.locator('textarea[aria-label="Message Namzu"]').waitFor()
 const area=page.locator('textarea[aria-label="Message Namzu"]')
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
 const writeClipboard=(items)=>page.evaluate(async({items,png})=>{
  const canvas=document.createElement('canvas');canvas.width=canvas.height=16
  const ctx=canvas.getContext('2d');ctx.fillStyle='#3b82f6';ctx.fillRect(0,0,16,16)
  const image=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'))
  const data={}
  if(items.text)data['text/plain']=new Blob([items.text],{type:'text/plain'})
  if(items.image)data['image/png']=image
  await navigator.clipboard.write([new ClipboardItem(data)])
 },{items,png})
 // 1. text + image rendering: the text must land in the composer.
 await area.click()
 await writeClipboard({text:'Pasted table text',image:true})
 await page.keyboard.press('Control+V')
 await expect(area).toHaveValue(/Pasted table text/)
 const value=await area.inputValue()
 check('paste keeps text when the clipboard also has an image',value.includes('Pasted table text'),{value})
 await page.screenshot({path:join(out,'1-paste-text-with-image.png')})
 await area.fill('')
 // 5. image-only paste attaches; removal moves focus.
 for(let i=0;i<2;i++){await writeClipboard({image:true});await area.click();await page.keyboard.press('Control+V');await expect(page.locator('.attachment-list .attachment-item')).toHaveCount(i+1)}
 const chips=page.locator('.attachment-list .attachment-item')
 const count=await chips.count()
 check('image-only paste attaches files',count>=1,{count})
 await page.screenshot({path:join(out,'5-chips-before-removal.png')})
 const names=[]
 for(let i=count;i>0;i--){
  await chips.first().locator('.attachment-remove').click()
  await expect(chips).toHaveCount(i-1)
  if(i>1)await expect(page.locator(':focus')).toHaveAttribute('aria-label',/^Remove /)
  else await expect(page.locator(':focus')).toHaveAttribute('aria-label','Message Namzu')
  const active=await page.evaluate(()=>({tag:document.activeElement?.tagName,label:document.activeElement?.getAttribute('aria-label')}))
  names.push(active)
  if(i>1)check(`focus moves to a remaining remove button (${i} left)`,active.tag==='BUTTON'&&/^Remove /.test(active.label??''),active)
  else check('focus returns to the composer after the last chip',active.tag==='TEXTAREA'&&active.label==='Message Namzu',active)
 }
 await page.screenshot({path:join(out,'5-focus-after-last-removal.png')})
 // 6. focus after clicking Send.
 await area.fill('Focus check message')
 await page.evaluate(()=>{window.__f=[];for(const t of ['focusin','focusout'])document.addEventListener(t,e=>window.__f.push(t+':'+(e.target.getAttribute?.('aria-label')||e.target.tagName)),true)})
 await page.getByRole('button',{name:/^Send message$/}).click()
 await page.waitForFunction(()=>document.activeElement?.tagName==='TEXTAREA')
 const after=await page.evaluate(()=>({tag:document.activeElement?.tagName,label:document.activeElement?.getAttribute('aria-label'),value:document.querySelector('textarea[aria-label="Message Namzu"]')?.value,log:window.__f}))
 // The design preview refuses to send, so the draft stays; the focus handoff is what is under test.
 check('focus returns to the textarea after a button send',after.tag==='TEXTAREA'&&after.log.some(e=>e.startsWith('focusin:Send')),after)
 await page.screenshot({path:join(out,'6-focus-after-send.png')})
}finally{
 await browser.close();await server.close()
 await writeFile(join(out,'proof.json'),JSON.stringify(report,null,1)+'\n')
}
console.log(JSON.stringify(report,null,1))
