import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, mkdir, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Source components/CSS, with only module aliases adjusted. No peer runtime or credentials. */
export async function compareSourceSurface(desktop, page, repo, peer) {
 assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:peer,encoding:'utf8'}).trim(),'c18e5ea6ed741443a8ec4a5d22d4b6939b0ecd21')
 const require = createRequire(join(repo, 'packages/desktop/package.json'))
 const { createServer } = await import(require.resolve('vite'))
 const { expect } = require('@playwright/test')
 const tailwindcss = (await import(require.resolve('@tailwindcss/vite'))).default
 const root = await mkdtemp(join(tmpdir(), 'ui-reference-'))
 await writeFile(join(root, 'tsconfig.json'), JSON.stringify({compilerOptions:{jsx:'react-jsx'}}))
 await mkdir(join(root, 'original'))
 await mkdir(join(root, 'lib'))
 await symlink(join(repo, 'packages/desktop/node_modules'), join(root, 'node_modules'), 'dir')
 const source = join(peer, 'apps/web/src')
 const originals = [
  ['components/chat/ComposerSurface.tsx','ComposerSurface.tsx'],
  ['components/chat/ComposerControl.tsx','ComposerControl.tsx'],
  ['components/WorkspacePageHeader.tsx','WorkspacePageHeader.tsx'],
  ['components/ui/button.tsx','button.tsx'],
  ['components/ui/separator.tsx','separator.tsx'],
  ['workspaceTitlebar.ts','workspaceTitlebar.ts'],
  ['index.css','index.css'],
 ]
 for (const [from, to] of originals) {
  let text = await readFile(join(source, from), 'utf8')
  text = text.replaceAll('~/lib/utils','../lib/utils').replaceAll('../ui/separator','./separator').replaceAll('../workspaceTitlebar','./workspaceTitlebar')
  await writeFile(join(root,'original',to), text)
 }
 await writeFile(join(root, 'lib/utils.ts'), "import {cx} from 'class-variance-authority'; import {twMerge} from 'tailwind-merge'; export const cn=(...args)=>twMerge(cx(...args));\n")
 const entry = await readFile(join(repo,'research/runtime-desktop-20260930/reference-entry.tsx'),'utf8')
 // Verify the selected render branches are grounded in the original composed source.
 const row = await readFile(join(source,'components/Sidebar.tsx'),'utf8')
 const messages = await readFile(join(source,'components/chat/MessagesTimeline.tsx'),'utf8')
 const composer = await readFile(join(source,'components/chat/ChatComposer.tsx'),'utf8')
 for (const literal of ['relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)', 'mt-1 flex min-w-0', 'mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs']) assert.ok(row.includes(literal) && entry.includes(literal))
 for (const literal of ['relative max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground','relative min-w-0 px-1 py-0.5']) assert.ok(messages.includes(literal) && entry.includes(literal))
 assert.ok(composer.includes('flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-3 pb-3 sm:px-4 sm:pb-4'))
 await writeFile(join(root,'entry.tsx'),entry)
 const data = await page.evaluate(() => ({
  project: document.querySelector('.breadcrumb > span').textContent,
  title: document.querySelector('.breadcrumb strong').textContent,
  model: document.querySelector('.model-picker-trigger > span').textContent,
  draft: document.querySelector('.composer-input textarea').value,
  composerHeight: document.querySelector('.composer-wrap').getBoundingClientRect().height,
  messages: [...document.querySelectorAll('.message')].map(node => ({role:node.dataset.messageRole,text:node.querySelector('.message-text').textContent, html:node.querySelector('.message-text').innerHTML})),
 }))
 const originalScroll = await page.locator('.transcript').evaluate(node => node.scrollTop)
 const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dark:document.documentElement.classList.contains('dark') }))
 await writeFile(join(root,'index.html'), `<html class="${viewport.dark ? 'dark' : ''}"><body><div id="root"></div><script>window.referenceData=${JSON.stringify(data).replaceAll('<','\\u003c')}</script><script type="module" src="/entry.tsx"></script></body></html>`)
 const server = await createServer({root, configFile:false, plugins:[tailwindcss()], server:{host:'127.0.0.1',port:0}, resolve:{dedupe:['react','react-dom']}, optimizeDeps:{include:['react','react-dom/client','lucide-react','@base-ui/react/use-render','@base-ui/react/merge-props']}})
 await server.listen()
 let reference
 try {
  const nextWindow = desktop.waitForEvent('window')
  await desktop.evaluate(({BrowserWindow}, options) => { const window = new BrowserWindow({width:options.width,height:options.height,useContentSize:true,show:true,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}}); void window.loadURL(options.url) }, {...viewport,url:`http://127.0.0.1:${server.httpServer.address().port}`})
  reference = await nextWindow
  try { await expect(reference.locator('[data-ref=send]')).toBeVisible() } catch(error) { console.error(await reference.locator('body').innerText()); throw error }
  await reference.evaluate(() => document.fonts.ready)
  await reference.locator('[data-ref=transcript]').evaluate(node => { node.scrollTop = 0 })
  await page.locator('.transcript').evaluate(node => { node.scrollTop = 0 })
  const pairs = [
   ['card','.conversations [aria-current=page]','[data-ref=card]'],
   ['header','.topbar','[data-ref=header]'],
   ['user','.message.user > div','[data-ref=user]'],
   ['assistant','.message.assistant .message-text','[data-ref=assistant]'],
   ['code','.chat-markdown pre code','[data-ref=assistant] pre code'],
   ['host','[data-slot=composer-host]','[data-slot=composer-host]'],
   ['body','[data-chat-composer-body]','[data-ref=composer-body]'],
   ['editor','.composer-input textarea','[data-ref=editor]'],
   ['footer','[data-chat-composer-footer]','[data-ref=footer]'],
   ['model','.model-picker-trigger','[data-ref=model]'],
   ['send','button[aria-label="Send message"]','[data-ref=send]'],
   ['context','[data-slot=composer-context-strip]','[data-slot=composer-context-strip]'],
  ]
  const measure = (node) => { const rect=node.getBoundingClientRect(), s=getComputedStyle(node); const pseudo=getComputedStyle(node,'::after'); return {width:rect.width,height:rect.height,fontFamily:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,letterSpacing:s.letterSpacing,padding:[s.paddingTop,s.paddingRight,s.paddingBottom,s.paddingLeft],radius:s.borderRadius,afterBorder:pseudo.borderWidth,afterRadius:pseudo.borderRadius} }
  const result = {}
  for (const [name,localSelector,refSelector] of pairs) {
   const local=await page.locator(localSelector).first().evaluate(measure)
   const original=await reference.locator(refSelector).first().evaluate(measure)
   result[name]={local,reference:original}
  }
  await reference.screenshot({path:join(repo,'research/runtime-desktop-20260930/artifacts/reference-source.png')})
  await page.screenshot({path:join(repo,'research/runtime-desktop-20260930/artifacts/reference-local.png')})
  await writeFile(join(repo,'research/runtime-desktop-20260930/artifacts/reference-observations.json'),JSON.stringify(result,null,2)+'\n')
  for(const key of ['card','header','user','assistant','host','body','editor','footer','model','send','context']) {
   for(const field of ['height','radius']) assert.equal(result[key].local[field],result[key].reference[field],`${key}.${field}`)
  }
  for(const key of ['user','assistant','code','model','editor']) {
   for(const field of ['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing']) assert.equal(result[key].local[field],result[key].reference[field],`${key}.${field}`)
  }
  // Equivalent visible message content and scroll offset; completed tool rows are outside this comparison's scope.
  assert.equal(result.host.local.width,result.host.reference.width)
  assert.equal(result.assistant.local.width,result.assistant.reference.width)
  const receipt={sourceRevision:'c18e5ea6ed741443a8ec4a5d22d4b6939b0ecd21',scope:'isolated original presentation components and CSS, selected render branches; not the full peer runtime',viewport,scrollOffset:0,fields:result,brandDifferences:['wordmark','action and focus colors'],nativeContent:data.messages.length}
  await writeFile(join(repo,'research/runtime-desktop-20260930/artifacts/reference-comparison.json'),JSON.stringify(receipt,null,2)+'\n')
  return receipt
 } finally {
  await page.locator('.transcript').evaluate((node,scroll) => { node.scrollTop=scroll },originalScroll)
  if(reference) await reference.evaluate(() => window.close())
  await server.close()
 }
}
