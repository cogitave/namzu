import { createRequire } from 'node:module'
const require = createRequire('/home/arda/workspaces/@cogitave/cogitave/namzu/packages/desktop/package.json')
const { chromium } = require('@playwright/test')
const OUT = '/home/arda/workspaces/@cogitave/cogitave/namzu/research/model-list-compact-20261008'
const [theme = 'dark', mode = 'claude', tag = 'claude'] = process.argv.slice(2)
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1100, height: 800 } })
const p = await ctx.newPage()
const errors = []
p.on('console', m => { if (m.type()==='error') errors.push(m.text()) })
await p.addInitScript(([t, m]) => { if (!sessionStorage.getItem('init')) { sessionStorage.setItem('init','1'); try { localStorage.clear(); localStorage.setItem('namzu.preview.models', m); if (t==='light') localStorage.setItem('namzu.appearance','light') } catch {} } }, [theme, mode])
const trigText = () => p.evaluate(()=>document.querySelector('.model-picker-trigger')?.textContent)
const rows = () => p.evaluate(()=>[...document.querySelectorAll('.model-picker-popup [role=radio]')].map(r=>r.getAttribute('aria-label')+(r.getAttribute('aria-checked')==='true'?' [x]':'')))
async function openList() {
  await p.waitForTimeout(500)
  if (!(await p.locator('.model-picker-popup').count())) { await p.locator('.model-picker-trigger').first().click(); await p.waitForTimeout(500) }
  await p.getByText(', change model').click().catch(()=>{}); await p.waitForTimeout(600)
}
async function newPane() {
  for (let i = 0; i < 4; i++) {
    await p.getByText('New conversation', { exact: true }).first().click(); await p.waitForTimeout(1300)
    if (await p.getByText('What would you like to work on?').count()) return
  }
  throw new Error('no landing')
}
await p.goto('http://127.0.0.1:5173/preview'); await p.waitForTimeout(1800)
await newPane()
console.log(tag, 'new pane trigger:', await trigText())
await openList()
console.log('compact rows', await rows())
await p.screenshot({ path: `${OUT}/${tag}-${theme}-1-compact.png` })
await p.locator('.model-picker-fold').click(); await p.waitForTimeout(400)
console.log('expanded rows', (await rows()).length)
await p.screenshot({ path: `${OUT}/${tag}-${theme}-2-expanded.png` })
await p.locator('.model-picker-popup [role=radio][aria-checked=true]').focus()
const seq=[]
for (let i=0;i<7;i++){ await p.keyboard.press('ArrowDown'); await p.waitForTimeout(60); seq.push(await p.evaluate(()=>document.activeElement?.getAttribute('aria-label'))) }
console.log('arrow focus', seq)
await p.keyboard.press('Enter'); await p.waitForTimeout(600)
console.log('trigger after older pick:', await trigText())
await openList()
await p.screenshot({path:'a2dbg.png'}); console.log('popup rows after older pick', await rows(), '| fold:', await p.locator('.model-picker-fold').textContent())
await p.screenshot({ path: `${OUT}/${tag}-${theme}-3-pinned-older.png` })
await p.getByRole('button', { name: 'Search models' }).click(); await p.waitForTimeout(300)
await p.keyboard.type(mode==='versions' ? 'opus 4' : mode==='aliases' ? 'opus' : 'luna', { delay: 40 }); await p.waitForTimeout(300)
console.log('search rows', await rows())
await p.screenshot({ path: `${OUT}/${tag}-${theme}-4-search.png` })
await p.keyboard.press('Escape'); await p.waitForTimeout(400)
await p.goto('http://127.0.0.1:5173/preview'); await p.waitForTimeout(1800)
await newPane()
console.log('after reload, a new pane starts with:', await trigText())
await p.screenshot({ path: `${OUT}/${tag}-${theme}-5-continues.png` })
console.log('errors', errors)
await b.close()
