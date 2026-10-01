import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, mkdir, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectPlatformFonts } from './platform-fonts.mjs'

/** Source components/CSS, with only module aliases adjusted. No peer runtime or credentials. */
export async function compareSourceSurface(desktop, page, repo, peer, scene = 'reference') {
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
  ['components/chat/ComposerBanner.tsx','ComposerBanner.tsx'],
  ['components/chat/ComposerPendingApprovalPanel.tsx','ComposerPendingApprovalPanel.tsx'],
  ['components/ui/scroll-area.tsx','scroll-area.tsx'],
  ['components/WorkspacePageHeader.tsx','WorkspacePageHeader.tsx'],
  ['components/WorkspaceBreadcrumb.tsx','WorkspaceBreadcrumb.tsx'],
  ['components/ui/button.tsx','button.tsx'],
  ['components/ui/separator.tsx','separator.tsx'],
  ['workspaceTitlebar.ts','workspaceTitlebar.ts'],
  ['index.css','index.css'],
  ['appearanceFonts.ts','appearanceFonts.ts'],
 ]
 for (const [from, to] of originals) {
  let text = await readFile(join(source, from), 'utf8')
  text = text.replaceAll('~/lib/utils','../lib/utils').replaceAll('../ui/separator','./separator').replaceAll('../workspaceTitlebar','./workspaceTitlebar').replaceAll('../ui/button','./button').replaceAll('../ui/scroll-area','./scroll-area')
  if(to === 'appearanceFonts.ts') text=text.replaceAll('@t3tools/contracts','./font-defaults')
  await writeFile(join(root,'original',to), text)
 }
 const settings=await readFile(join(peer,'packages/contracts/src/settings.ts'),'utf8')
 const fontDefaults=['DEFAULT_CODE_FONT_SIZE','DEFAULT_INTERFACE_FONT_SIZE','DEFAULT_PROMPT_FONT_SIZE','MAX_CODE_FONT_SIZE','MAX_INTERFACE_FONT_SIZE','MAX_PROMPT_FONT_SIZE','MIN_CODE_FONT_SIZE','MIN_INTERFACE_FONT_SIZE','MIN_PROMPT_FONT_SIZE']
 await writeFile(join(root,'original/font-defaults.ts'),fontDefaults.map(name=>{
  const match=settings.match(new RegExp(`export const ${name}(?::[^=]+)? = (\\d+);`));assert.ok(match,`${name} is sourced from contracts`)
  return `export const ${name}=${match[1]};`
 }).join('\n'))
 assert.ok(settings.includes('fontSmoothing: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true)))'))
 const artwork = await readFile(join(source,'components/SidebarStageBackdrop.tsx'),'utf8')
 // Render the actual pure artwork function. Runtime environment hooks are
 // intentionally excluded; neither local CSS nor local SVG enters this page.
 await writeFile(join(root,'original/HeaderBackdrop.tsx'), `import {useId} from 'react'; const STAGE_BACKDROP_VIEW_BOX='0 0 8192 96'; export function HeaderBackdrop(){return <div aria-hidden className="sidebar-stage-backdrop pointer-events-none absolute inset-x-0 top-0 z-0 h-20 select-none overflow-hidden"><DevBlueprintArt /></div>}\n${artwork.slice(artwork.indexOf('function DevBlueprintArt('))}`)
 await writeFile(join(root, 'lib/utils.ts'), "import {cx} from 'class-variance-authority'; import {twMerge} from 'tailwind-merge'; export const cn=(...args)=>twMerge(cx(...args));\n")
 const entry = await readFile(join(repo,'research/runtime-desktop-20260930/reference-entry.tsx'),'utf8')
 // Verify the selected render branches are grounded in the original composed source.
 const row = await readFile(join(source,'components/Sidebar.tsx'),'utf8')
 const messages = await readFile(join(source,'components/chat/MessagesTimeline.tsx'),'utf8')
 const composer = await readFile(join(source,'components/chat/ChatComposer.tsx'),'utf8')
 const chrome = await readFile(join(source,'components/sidebar/SidebarChrome.tsx'),'utf8')
 const header = await readFile(join(source,'components/chat/ChatHeader.tsx'),'utf8')
 for (const literal of ['min-w-10 flex-1', 'min-w-0 flex-1', '<WorkspaceBreadcrumbText>{activeThreadTitle}</WorkspaceBreadcrumbText>']) assert.ok(header.includes(literal), `actual ChatHeader title branch: ${literal}`)
 assert.ok(entry.includes('<WorkspaceBreadcrumb ariaLabel=') && entry.includes('<WorkspaceBreadcrumbText data-conversation-title>'))
 assert.ok(chrome.includes('@container/sidebar-header relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 px-3 md:px-0') && entry.includes('@container/sidebar-header relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 px-3 md:px-0'))
 for (const literal of ['group/timeline-row relative flex flex-col rounded-md px-0.5 transition-colors', 'flex select-none items-center gap-1.5 transition-[opacity,translate] duration-200']) assert.ok(messages.includes(literal) && entry.includes(literal))
 for (const literal of ['relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)', 'mt-1 flex min-w-0', 'mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs']) assert.ok(row.includes(literal) && entry.includes(literal))
 for (const literal of ['relative max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground','relative min-w-0 px-1 py-0.5']) assert.ok(messages.includes(literal) && entry.includes(literal))
 assert.ok(composer.includes('flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-3 pb-3 sm:px-4 sm:pb-4'))
 for (const literal of ['my-0 max-h-8 min-h-8 overflow-hidden py-0 whitespace-pre! leading-8', 'absolute bottom-px right-px z-10 h-12 w-auto gap-0 py-0 sm:gap-0 sm:py-0']) assert.ok(composer.includes(literal) && entry.includes(literal))
 await writeFile(join(root,'entry.tsx'),entry)
 const data = await page.evaluate(() => ({
  project: document.querySelector('.breadcrumb [data-project-label]').textContent,
  title: document.querySelector('.breadcrumb [data-conversation-title]').textContent,
  model: document.querySelector('.model-picker-trigger > span').textContent,
  draft: document.querySelector('.composer-input textarea').value,
  placeholder: document.querySelector('.composer-input textarea').placeholder,
  composerHeight: document.querySelector('.composer-wrap').getBoundingClientRect().height,
  resting: document.querySelector('[data-chat-composer-body]').dataset.resting === 'true',
  collapsed: document.querySelector('.app').dataset.sidebarCollapsed === 'true',
  approval: document.querySelector('[aria-label="Tool approval"]') ? {summary:document.querySelector('[data-approval-detail]').textContent,count:1} : null,
  messages: [...document.querySelectorAll('.message')].map(node => ({role:node.dataset.messageRole,text:node.querySelector('.message-text').textContent, html:node.querySelector('.message-text').innerHTML})),
  timeline: [...document.querySelectorAll('.conversation-body > [data-timeline-turn]')].map(node => node.classList.contains('tool-list') ? {kind:'tool',title:node.querySelector('summary > span:nth-of-type(2)').textContent,status:node.querySelector('.tool-status').textContent,icon:node.querySelector('.tool-icon svg').classList.contains('lucide-terminal') ? 'terminal' : 'diff'} : {kind:'message',role:node.dataset.messageRole,text:node.querySelector('.message-text').textContent,html:node.querySelector('.message-text').innerHTML}),
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
  try { await expect(reference.locator('[data-ref=editor]')).toBeVisible() } catch(error) { console.error(await reference.locator('body').innerText()); throw error }
  await reference.evaluate(() => document.fonts.ready)
  await reference.locator('[data-ref=transcript]').evaluate(node => { node.scrollTop = 0 })
  await page.locator('.transcript').evaluate(node => { node.scrollTop = 0 })
  const pairs = [
   ['sidebar','.sidebar','[data-app-sidebar]'],
   ['sidebarChrome','.sidebar-chrome','[data-ref=sidebar-chrome]'],
   ['stageArtwork','.sidebar-stage-backdrop','.sidebar-stage-backdrop'],
   ['card','.conversations [aria-current=page]','[data-ref=card]'],
   ['header','.topbar','[data-ref=header]'],
   ['headerTitle','.breadcrumb [data-conversation-title]','[data-ref=header] [data-conversation-title]'],
   ['headerProject','.breadcrumb [data-project-label]','[data-ref=header] [data-project-label]'],
   ['headerTrail','.breadcrumb > ol','[data-ref=header] nav > ol'],
   ['user','.message.user > div','[data-ref=user]'],
   ['assistant','.message.assistant .message-text','[data-ref=assistant]'],
   ['tool','.tool','[data-ref=tool]'],
   ['toolLabel','.tool summary > span:nth-of-type(2)','[data-ref=toolLabel]'],
   ['code','.chat-markdown pre code','[data-ref=assistant] pre code'],
   ['host','[data-slot=composer-host]','[data-slot=composer-host]'],
   ['body','[data-chat-composer-body]','[data-ref=composer-body]'],
   ['editor','.composer-input textarea','[data-ref=editor]'],
   ['footer','[data-chat-composer-footer]','[data-ref=footer]'],
   ['model','.model-picker-trigger','[data-ref=model]'],
   ['send','button[aria-label="Send message"]','[data-ref=send]'],
   ['context','[data-slot=composer-context-strip]','[data-slot=composer-context-strip]'],
  ].filter(([name]) => data.approval ? ['sidebar','sidebarChrome','stageArtwork','card','header','headerTitle','headerProject','headerTrail','user','context'].includes(name) : true)
  if(data.approval) pairs.push(
   ['approvalDetail','[data-approval-detail]','[data-approval-detail]'],
   ['decline','button:text-is("Decline")','button:text-is("Decline")'],
   ['approve','button:text-is("Allow once")','button:text-is("Allow once")'],
  )
  const measure = (node) => { const rect=node.getBoundingClientRect(), s=getComputedStyle(node); const pseudo=getComputedStyle(node,'::after'); return {width:rect.width,height:rect.height,fontFamily:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,letterSpacing:s.letterSpacing,textBoxTrim:s.textBoxTrim,textBoxEdge:s.textBoxEdge,gap:s.gap,padding:[s.paddingTop,s.paddingRight,s.paddingBottom,s.paddingLeft],radius:s.borderRadius,afterBorder:pseudo.borderWidth,afterRadius:pseudo.borderRadius} }
  const result = {}
  for (const [name,localSelector,refSelector] of pairs) {
   const local=await page.locator(localSelector).first().evaluate(measure)
   const original=await reference.locator(refSelector).first().evaluate(measure)
   result[name]={local,reference:original}
  }
  const fontPairs=[
   ['sidebarTitle','.conversations [aria-current=page] .mt-1 > span','[data-ref=card] .mt-1 > span'],
   ['sidebarProject','.conversations [aria-current=page] .h-5 > span:first-of-type','[data-ref=card] .h-5 > span:first-of-type'],
   ['headerTitle','.breadcrumb [data-conversation-title]','[data-ref=header] [data-conversation-title]'],
   ['headerProject','.breadcrumb [data-project-label]','[data-ref=header] [data-project-label]'],
   ['composer','.composer-input textarea','[data-ref=editor]'],
   ...(!data.approval ? [['assistant','.message.assistant .message-text p','[data-ref=assistant] p'],['code','.chat-markdown pre code','[data-ref=assistant] pre code'],['model','.model-picker-trigger > span','[data-ref=model] > span']] : [['approval','[data-approval-detail]','[data-approval-detail]']]),
  ]
  const typography={local:await inspectPlatformFonts(page,fontPairs.map(([name,selector])=>[name,selector])),reference:await inspectPlatformFonts(reference,fontPairs.map(([name,,selector])=>[name,selector]))}
  for(const [name] of fontPairs) {
   assert.deepEqual(typography.local.roles[name].explicitTextProbeFonts,typography.reference.roles[name].explicitTextProbeFonts,`${name} actual resolved font faces`)
   assert.deepEqual(typography.local.roles[name].declared,typography.reference.roles[name].declared,`${name} typography`)
  }
  for(const key of ['headerTitle','headerProject']) for(const field of ['height','padding','textBoxTrim','textBoxEdge']) assert.deepEqual(result[key].local[field],result[key].reference[field],`${key}.${field}`)
  assert.equal(result.headerTrail.local.gap,result.headerTrail.reference.gap,'headerTrail.source gap')
  await reference.screenshot({path:join(repo,`research/runtime-desktop-20260930/artifacts/${scene}-source.png`)})
  await page.screenshot({path:join(repo,`research/runtime-desktop-20260930/artifacts/${scene}-local.png`)})
  await writeFile(join(repo,`research/runtime-desktop-20260930/artifacts/${scene}-observations.json`),JSON.stringify(result,null,2)+'\n')
  for(const key of ['sidebar','sidebarChrome','stageArtwork','card','header','user','assistant','tool','host','body','editor','footer','model','send','context','approvalDetail','decline','approve'].filter(key=>result[key])) {
   for(const field of ['height','radius']) assert.equal(result[key].local[field],result[key].reference[field],`${key}.${field}`)
  }
  for(const key of ['user','assistant','toolLabel','code','model','editor','approvalDetail','decline','approve'].filter(key=>result[key])) {
   for(const field of ['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing']) assert.equal(result[key].local[field],result[key].reference[field],`${key}.${field}`)
  }
  // Equivalent visible content and scroll offset; tool rows use the verified
  // collapsed presentation branch, while expanded runtime output is excluded.
  if(!data.approval) {
   assert.equal(result.host.local.width,result.host.reference.width)
   assert.equal(result.assistant.local.width,result.assistant.reference.width)
  }
  const receipt={sourceRevision:'c18e5ea6ed741443a8ec4a5d22d4b6939b0ecd21',scope:'original presentation components, original stylesheet, pure header artwork and verified full resting/expanded composition branches; excludes reference runtime/store, sidebar resize, tool expansion and approval batch semantics; tools use verified collapsed-row source branches with the same admitted sequence',viewport,scrollOffset:0,state:{resting:data.resting,collapsed:data.collapsed,approval:Boolean(data.approval)},fields:result,typography,brandDifferences:['ASCII wordmark','phosphor header palette','action and focus colors','one-pixel sidebar divider'],intentionalBehaviorDifferences:data.approval ? ['Namzu retains a writable follow-up editor and stop action during approval','complete batch disclosure and one-batch grant scope'] : [],nativeContent:data.messages.length}
  await writeFile(join(repo,`research/runtime-desktop-20260930/artifacts/${scene}-comparison.json`),JSON.stringify(receipt,null,2)+'\n')
  return receipt
 } finally {
  await page.locator('.transcript').evaluate((node,scroll) => { node.scrollTop=scroll },originalScroll)
  if(reference) await reference.evaluate(() => window.close())
  await server.close()
 }
}
