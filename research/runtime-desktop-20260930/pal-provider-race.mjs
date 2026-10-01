import {createRequire} from 'node:module'
import {writeFileSync, mkdirSync} from 'node:fs'
import {resolve, join} from 'node:path'
const root=resolve(process.argv[2]??process.cwd())
const output=join(root,'research/runtime-desktop-20260930/artifacts')
mkdirSync(output,{recursive:true})
const require=createRequire(join(root,'packages/desktop/package.json'))
const {chromium,expect}=require('@playwright/test')
const browser=await chromium.launch({headless:true})
try {
const page=await browser.newPage({viewport:{width:1800,height:1000}})
const errors=[];page.on('pageerror',e=>errors.push(e.message))
await page.addInitScript(()=>{
 let current
 Object.defineProperty(window,'namzu',{configurable:true,get:()=>current,set:(api)=>{
  current=api
  const state=window.__palProviderProof={calls:[],held:false,historyHeld:false}
  const original={pals:api.pals.bind(api),providers:api.providers.bind(api),openConversation:api.openConversation.bind(api),selectProvider:api.selectProvider.bind(api)}
  const setup=(async()=>{
   const pal=await api.createPal({name:'Race Pal',purpose:'Provider ownership proof',model:{provider:'anthropic',model:'sample-quick'}})
   state.pal=pal
   const opened=await api.openPal(pal.id)
   state.project=opened.project
   state.conversation=await api.newConversation(opened.project.id)
  })()
  api.pals=async()=>{await setup;return original.pals()}
  api.providers=async(projectId,id)=>{
   await setup
   if(projectId!==state.project.id)return original.providers(projectId,id)
   const result=await original.providers(projectId,id)
   if(id)return {...result,selected:{id:'anthropic',model:'sample-focused'}}
   state.held=true
   return new Promise(resolve=>{state.release=()=>resolve({...result,selected:{id:'anthropic',model:'sample-quick'}})})
  }
  api.openConversation=async(projectId,id)=>{
   await setup
   if(projectId===state.project.id){state.historyHeld=true;await new Promise(resolve=>{state.releaseHistory=resolve})}
   return original.openConversation(projectId,id)
  }
  api.palComputer=async()=>({status:'ready',environmentId:'fixture-only',generation:'1'})
  api.selectProvider=async(id,provider,model)=>{state.calls.push({kind:'select',id,provider,model});return original.selectProvider(id,provider,model)}
  api.send=async(id,text)=>{state.calls.push({kind:'send',id,text})}
 }})
})
await page.goto(process.argv[3]??'http://localhost:5173/preview')
await page.locator('.sidebar-pal-row').filter({hasText:'Race Pal'}).click()
await page.waitForFunction(()=>window.__palProviderProof.held && window.__palProviderProof.historyHeld)
await page.evaluate(()=>window.__palProviderProof.releaseHistory())
await expect(page.getByRole('button',{name:'Select model',exact:true})).toContainText('sample-focused')
await page.evaluate(()=>window.__palProviderProof.release())
await expect(page.getByRole('button',{name:'Select model',exact:true})).toContainText('sample-focused')
await page.getByRole('textbox',{name:'Message Namzu',exact:true}).fill('Verify pinned provider')
await page.getByRole('button',{name:'Send message',exact:true}).click()
await page.waitForFunction(()=>window.__palProviderProof.calls.some(call=>call.kind==='send'))
const calls=await page.evaluate(()=>window.__palProviderProof.calls)
if(!calls.some(call=>call.kind==='select'&&call.model==='sample-focused'))throw new Error('Pinned provider was overwritten')
if(calls.some(call=>call.kind==='select'&&call.model==='sample-quick'))throw new Error('Landing provider reached send')
if(errors.length)throw new Error(errors.join('\n'))
writeFileSync(join(output,'pal-provider-race-20261002.json'),JSON.stringify({passed:true,calls,errors,checks:['deferred landing response released after pinned conversation selection','composer retains pinned route','send selects pinned route'],limitations:['Injected browser API only, no real provider or computer execution.']},null,2))
}finally{await browser.close()}
