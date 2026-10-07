/** Actual Desktop DOM motion with a paused Chromium timeline and virtual JS clock. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { installFixture, persistenceFixture } from './fixture.mjs'

const repo = resolve(process.argv[2] ?? '.')
const artifacts = join(repo, 'research/transcript-motion-20261007/artifacts')
await mkdir(artifacts, { recursive: true })
const fixture = JSON.parse(await readFile(join(repo, 'research/transcript-search-timing-20261007/artifacts/journal-fixtures.json'), 'utf8'))
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { createServer } = await import(require.resolve('vite'))
const { chromium, expect } = require('@playwright/test')
const persistenceOnly = process.argv.includes('--persistence-only')
const pendingScrollOnly = process.argv.includes('--pending-scroll-only')
const sourcePaths = ['app.tsx', 'transcript.tsx', 'transcript-motion.ts', 'transcript-motion.css', 'workspace-presentation.ts', 'use-transcript-scroll.ts', 'ui/collapsible.tsx']
const sourceFingerprint = () => Promise.all(sourcePaths.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(join(repo, 'packages/desktop/src/renderer', path))).digest('hex') })))
const source = await sourceFingerprint()
const proofId = randomUUID().slice(0, 8)
const sourceKey = createHash('sha256').update(JSON.stringify(source)).digest('hex').slice(0, 8)
const outputFile = pendingScrollOnly ? `pending-scroll-races-${sourceKey}-${proofId}.json` : persistenceOnly ? `disclosure-persistence-${sourceKey}-${proofId}.json` : `${process.argv.includes('--before') ? 'hover-fixed-before' : 'hover-fixed-layout'}-${sourceKey}-${proofId}.json`
const shot = name => join(artifacts, `${sourceKey}-${proofId}-${name}`)
const server = await createServer({ root: join(repo, 'packages/desktop'), server: { host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'error' })
await server.listen()
const origin = `http://127.0.0.1:${server.httpServer.address().port}/preview`
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] })
const before = process.argv.includes('--before')
const receipt = { passed: false, source, capturedAt: new Date().toISOString(), timeline: 'Chromium Animation playback paused; individual actual animations seeked at explicit fractions; Playwright JS timers advanced virtually.', imageProvenance: 'Unqualified screenshot paths were reused during draft runs and may show stale cached captures. Use each settled-rendered-body.authoritativeScreenshot with its SHA-256.', nativeActions: 0, providerRequests: 0, measurements: [], checks: [], pageErrors: [], limits: ['UI-only synthetic live conversation; no native app, paid prompt, reference app agent execution, or pixel parity claim. Controlled fixture work lasts15s; this is not an inference benchmark.'] }

async function flush(page, ms = 32) { await page.clock.runFor(ms); await page.evaluate(() => { document.body.getBoundingClientRect() }) }
async function finish(page) {
  await page.evaluate(() => { for (const a of document.getAnimations()) if (Number.isFinite(a.effect?.getComputedTiming().endTime)) { try { a.finish() } catch {} } })
  await flush(page, 32)
}
async function seek(page, selector, fraction) {
  return page.locator(selector).evaluate((element, fraction) => {
    return element.getAnimations({ subtree: true }).map(animation => {
      const timing = animation.effect?.getComputedTiming()
      if (timing && Number.isFinite(timing.endTime)) { animation.pause(); animation.currentTime = timing.endTime * fraction }
      return { type: animation.constructor.name, id: animation.id, transitionProperty: animation.transitionProperty, animationName: animation.animationName, currentTime: animation.currentTime, timing, keyframes: animation.effect?.getKeyframes() }
    })
  }, fraction)
}
async function snapshot(page, selector) {
  return page.locator(selector).evaluate(element => {
    const rect = node => { const r = node?.getBoundingClientRect(); return r && { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom } }
    const style = getComputedStyle(element)
    const clock = element.querySelector('.message-time')
    const clockStyle = clock && getComputedStyle(clock)
    const chevron = element.querySelector('.disclosure-chevron')
    const c = chevron?.getBoundingClientRect()
    const duration = element.querySelector('.tool-duration')
    const durationStyle = duration && getComputedStyle(duration)
    const icon = element.querySelector('.tool-icon') ?? element.querySelector('svg')
    const label = element.querySelector('.tool-label') ?? element.querySelector('.transcript-phase-text')
    const normal = element.closest('.normal-transcript')
    const transcript = element.closest('.transcript')
    const layout = { parent:rect(element.parentElement), previous:rect(element.previousElementSibling), next:rect(element.nextElementSibling), transcript:rect(transcript), transcriptScrollHeight:transcript?.scrollHeight, transcriptScrollTop:transcript?.scrollTop, transcriptClientHeight:transcript?.clientHeight, totalHeight:normal?.getBoundingClientRect().height, entries:[...normal.querySelectorAll('[data-transcript-entry-key], .turn-activity, .activity-trigger')].map(child=>({key:child.dataset.transcriptEntryKey??child.dataset.activityTurn??child.className,rect:rect(child)})) }
    return { rect: rect(element), layout, opacity: style.opacity, height: style.height, display: style.display, color:style.color, backgroundColor:style.backgroundColor, labelColor:label && getComputedStyle(label).color, iconColor:icon && getComputedStyle(icon).color, transitionProperty: style.transitionProperty, transitionDuration: style.transitionDuration, borderBottomWidth: style.borderBottomWidth, borderBottomColor: style.borderBottomColor, open: element.getAttribute('aria-expanded'), dataOpen: element.hasAttribute('data-open'), starting: element.hasAttribute('data-starting-style'), ending: element.hasAttribute('data-ending-style'), chevron: rect(chevron), pointerTarget: c && document.elementFromPoint(c.x+c.width/2,c.y+c.height/2)?.closest('button')?.getAttribute('aria-label'), clock: clock && { rect: rect(clock), opacity: clockStyle.opacity, maxWidth: clockStyle.maxWidth, maxHeight: clockStyle.maxHeight }, duration: duration && {rect:rect(duration),opacity:durationStyle.opacity,maxWidth:durationStyle.maxWidth,maxHeight:durationStyle.maxHeight}, animations: element.getAnimations({ subtree: true }).map(a => ({ type: a.constructor.name, property: a.transitionProperty, id: a.id, playState: a.playState, currentTime: a.currentTime, duration: a.effect?.getComputedTiming().duration })) }
  })
}
function hoverGeometry(sample) {
  const slot = element => element && {rect:element.rect,maxWidth:element.maxWidth,maxHeight:element.maxHeight}
  return {rect:sample.rect,layout:sample.layout,clock:slot(sample.clock),duration:slot(sample.duration),chevron:sample.chevron}
}
async function prepareReader(page, selector) {
  // Isolated fixture only: keep the reader in a comparable position before a
  // baseline. Otherwise Playwright's later hover/focus may scroll an offscreen
  // row into view, which tests the runner's auto-scroll rather than hover CSS.
  // Exercise the actual scroll/follow event handlers; do not alter app storage.
  await page.locator(selector).evaluate(element => {
    const transcript = element.closest('.transcript')
    if (!transcript) throw new Error('The motion target has no transcript reader.')
    transcript.dispatchEvent(new WheelEvent('wheel', {deltaY:-1,bubbles:true}))
    const viewport = transcript.getBoundingClientRect()
    const target = element.getBoundingClientRect()
    transcript.scrollTop += target.top - viewport.top - Math.max(0, (transcript.clientHeight - target.height) / 2)
    transcript.dispatchEvent(new Event('scroll'))
    transcript.dispatchEvent(new WheelEvent('wheel', {deltaY:-1,bubbles:true}))
  })
  await flush(page,64); await finish(page)
  return page.locator(selector).evaluate(element => {
    const viewport = element.closest('.transcript').getBoundingClientRect()
    const target = element.getBoundingClientRect()
    if (target.top < viewport.top - 0.5 || target.bottom > viewport.bottom + 0.5)
      throw new Error(`The baseline target is outside its reader: ${JSON.stringify({top:target.top,bottom:target.bottom,viewportTop:viewport.top,viewportBottom:viewport.bottom})}`)
    return {scrollTop:element.closest('.transcript').scrollTop,targetTop:target.top,targetBottom:target.bottom,viewportTop:viewport.top,viewportBottom:viewport.bottom,directStorageWrites:0}
  })
}
async function hoverSeries(page, selector, scenario, name, hoverTarget = selector) {
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).hover()
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).focus()
  await finish(page)
  const readerSetup = await prepareReader(page,selector)
  const rest = await snapshot(page, selector)
  if (name === 'tool' || name === 'user-bubble') await page.screenshot({ path: shot(`${scenario}-${name}-hover-rest.png`) })
  await page.locator(hoverTarget).hover()
  await flush(page)
  const animations = await seek(page, selector, 0)
  const start = await snapshot(page, selector)
  if (name === 'tool' || name === 'user-bubble') await page.screenshot({ path: shot(`${scenario}-${name}-hover-start.png`) })
  await seek(page, selector, 0.25)
  const quarter = await snapshot(page, selector)
  await seek(page, selector, 0.5)
  const middle = await snapshot(page, selector)
  await page.screenshot({ path: shot(`${scenario}-${name}-hover-middle.png`) })
  await seek(page, selector, 1)
  const end = await snapshot(page, selector)
  if (name === 'tool' || name === 'user-bubble') await page.screenshot({ path: shot(`${scenario}-${name}-hover-end.png`) })
  receipt.measurements.push({ scenario, kind: 'hover', name, readerSetup, rest, start, quarter, middle, end, animations })
  if (!before) {
    assert.equal(rest.clock.opacity, '0')
    assert.equal(end.clock.opacity, '1')
    assert.ok(rest.clock.rect.width > 0 && rest.clock.rect.height > 0, 'A known clock has a stable slot before hover')
    for (const sample of [start,quarter,middle,end]) assert.deepEqual(hoverGeometry(sample),hoverGeometry(rest), `${name}: hover must not move any row, neighbour, clock or scroll position`)
    if (!scenario.startsWith('reduced-')) {
      assert.equal(start.clock.opacity, '0')
      assert.ok(Number(middle.clock.opacity) > 0 && Number(middle.clock.opacity) < 1)
      assert.ok(animations.some(a => a.transitionProperty === 'opacity' && a.timing.duration === 160))
      assert.ok(animations.every(a => !['max-width','max-height','width','height'].includes(a.transitionProperty)))
      if (name === 'tool' || name === 'duration-tool') {
        assert.equal(start.labelColor, end.labelColor)
        assert.equal(start.iconColor, end.iconColor)
        assert.notEqual(start.backgroundColor, middle.backgroundColor)
        assert.notEqual(middle.backgroundColor, end.backgroundColor)
      }
    } else assert.ok(animations.every(a => a.transitionProperty !== 'opacity'))
  }
  await finish(page)
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).hover()
  await flush(page)
  const leaveAnimations = await seek(page, selector, 0)
  const leaveStart = await snapshot(page, selector)
  await seek(page, selector, 0.5)
  const leaveMiddle = await snapshot(page, selector)
  await page.locator(hoverTarget).hover()
  await flush(page)
  const reenterAnimations = await seek(page, selector, 0)
  const reenterStart = await snapshot(page, selector)
  await seek(page, selector, 0.5)
  const reenterMiddle = await snapshot(page, selector)
  await seek(page, selector, 1)
  const reentered = await snapshot(page, selector)
  receipt.measurements.push({ scenario, kind:'hover-interruption', name, leaveStart, leaveMiddle, reenterStart, reenterMiddle, reentered, leaveAnimations, reenterAnimations })
  if (!before) for (const sample of [leaveStart,leaveMiddle,reenterStart,reenterMiddle,reentered]) assert.deepEqual(hoverGeometry(sample),hoverGeometry(rest),`${name}: leave/re-enter must not move layout`)
  if (!before && !scenario.startsWith('reduced-')) {
    assert.ok(Math.abs(leaveMiddle.clock.rect.width-reenterStart.clock.rect.width)<1)
    assert.ok(Math.abs(Number(leaveMiddle.clock.opacity)-Number(reenterStart.clock.opacity))<0.01)
    assert.equal(reentered.clock.opacity,'1')
  }
  await finish(page)
  await page.getByRole('button', {name:'Toggle sidebar',exact:true}).hover()
  await page.getByRole('button', {name:'Toggle sidebar',exact:true}).focus()
  await finish(page)
  const focusTarget = name === 'tool' || name === 'duration-tool' || name === 'header' ? page.locator(selector) : page.locator(selector).locator('.message-time')
  await page.keyboard.press('Tab')
  await page.getByRole('button', {name:'Toggle sidebar',exact:true}).focus()
  await prepareReader(page,selector)
  const focusRest = await snapshot(page,selector)
  await focusTarget.focus()
  await flush(page)
  await seek(page,selector,1)
  const focused = await snapshot(page,selector)
  assert.equal(focused.clock.opacity,'1')
  assert.deepEqual(hoverGeometry(focused),hoverGeometry(focusRest),`${name}: keyboard focus must not move layout`)
  receipt.measurements.push({scenario,kind:'fixed-slot-focus',name,rest:focusRest,focused})
  await finish(page)
}
async function togglePanel(page, open, scenario, name) {
  const trigger = '.normal-transcript .activity-trigger'
  const selector = '.normal-transcript .turn-activity > [data-slot="collapsible-panel"]'
  const rest = await snapshot(page, selector)
  await page.locator(trigger).evaluate(element => element.click())
  await flush(page)
  const animations = await seek(page, selector, 0)
  const start = await snapshot(page, selector)
  await seek(page, selector, 0.5)
  const middle = await snapshot(page, selector)
  await page.screenshot({ path: shot(`${scenario}-${name}-middle.png`) })
  await seek(page, selector, 1)
  const end = await snapshot(page, selector)
  receipt.measurements.push({ scenario, kind: 'panel', name, open, rest, start, middle, end, animations })
  if (!before && !scenario.startsWith('reduced-')) {
    const full = open ? end.rect.height : start.rect.height
    assert.ok(full > 0)
    assert.ok(Math.abs(middle.rect.height / full - 0.5) < 0.01)
    assert.ok(Math.abs(Number(middle.opacity) - 0.5) < 0.01)
    assert.ok(animations.some(a => a.transitionProperty === 'height' && a.timing.duration === 260))
    assert.ok(animations.some(a => a.transitionProperty === 'opacity' && a.timing.duration === 260))
    assert.equal(open ? start.rect.height : end.rect.height, 0)
  } else if (!before) {
    assert.deepEqual(animations, [])
    assert.equal(start.rect.height, middle.rect.height)
    assert.equal(middle.rect.height, end.rect.height)
  }
  await finish(page)
  return { rest, start, middle, end }
}

const scenarios = persistenceOnly || pendingScrollOnly ? [] : before ? [{ name: 'before-wide-dark', viewport: { width: 1280, height: 900 }, appearance: 'dark', reducedMotion: 'no-preference' }] : [
  { name: 'wide-dark', viewport: { width: 1280, height: 900 }, appearance: 'dark', reducedMotion: 'no-preference' },
  { name: 'narrow-light', viewport: { width: 640, height: 720 }, appearance: 'light', reducedMotion: 'no-preference' },
  { name: 'minimum-dark', viewport: { width: 560, height: 640 }, appearance: 'dark', reducedMotion: 'no-preference' },
  { name: 'reduced-light', viewport: { width: 640, height: 720 }, appearance: 'light', reducedMotion: 'reduce' },
]
let context
try {
  for (const scenario of scenarios) {
    context = await browser.newContext({ viewport: scenario.viewport, colorScheme: scenario.appearance, reducedMotion: scenario.reducedMotion, timezoneId: 'Europe/Istanbul' })
    await context.route('**/*', route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort())
    const page = await context.newPage()
    page.setDefaultTimeout(12000)
    page.on('pageerror', error => receipt.pageErrors.push({ scenario: scenario.name, message: error.message }))
    await page.addInitScript(installFixture, { fixture, appearance: scenario.appearance })
    await page.goto(origin)
    await expect(page.getByText('Find RunPod H100 hourly prices and keep the source links.', { exact: true })).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    await page.clock.install()
    await page.clock.pauseAt(Date.now())
    const cdp = await context.newCDPSession(page)
    await cdp.send('Animation.enable')
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 })
    await flush(page)
    await togglePanel(page, true, scenario.name, 'cold-open')
    await hoverSeries(page,'.normal-transcript .message.user',scenario.name,'user-bubble','.normal-transcript .message.user > .relative')
    await hoverSeries(page,'.normal-transcript .message.assistant:not(.commentary)',scenario.name,'assistant-message')
    await hoverSeries(page, '.normal-transcript [data-tool-call-id="provider-hosted-web-search:0:provider-search-fixture"] .tool-trigger', scenario.name, 'tool')
    await page.locator('.normal-transcript .tool-group > .tool-trigger').evaluate(element => element.click())
    await flush(page); await finish(page)
    await hoverSeries(page, `.normal-transcript [data-tool-call-id="${fixture.technicalReceipts[0].toolUseId}"] .tool-trigger`, scenario.name, 'duration-tool')
    await page.locator('.normal-transcript .tool-group > .tool-trigger').evaluate(element => element.click())
    await flush(page); await finish(page)
    await hoverSeries(page, '.normal-transcript .activity-trigger', scenario.name, 'header')
    await page.keyboard.press('Tab')
    await page.locator('.normal-transcript .message.user .message-time').focus()
    await flush(page)
    const focusedClock = await page.locator('.normal-transcript .message.user .message-time').evaluate(element => ({focusVisible:element.matches(':focus-visible'),opacity:getComputedStyle(element).opacity,outlineWidth:getComputedStyle(element).outlineWidth,transitionDuration:getComputedStyle(element).transitionDuration,animations:element.getAnimations().map(a=>a.constructor.name)}))
    receipt.measurements.push({scenario:scenario.name,kind:'keyboard-clock',...focusedClock})
    assert.equal(focusedClock.focusVisible,true)
    assert.equal(focusedClock.opacity,'1')
    assert.equal(focusedClock.outlineWidth,'2px')
    await togglePanel(page, false, scenario.name, 'cold-close')
    await togglePanel(page, true, scenario.name, 'cold-reopen')
    const panel = '.normal-transcript .turn-activity > [data-slot="collapsible-panel"]'
    await page.locator('.normal-transcript .activity-trigger').evaluate(element => element.click())
    await flush(page)
    await seek(page, panel, 0.5)
    const interrupted = await snapshot(page, panel)
    await page.locator('.normal-transcript .activity-trigger').evaluate(element => element.click())
    await flush(page)
    const reverseAnimations = await seek(page, panel, 0)
    const reverseStart = await snapshot(page, panel)
    await seek(page, panel, 0.5)
    const reverseMiddle = await snapshot(page, panel)
    await seek(page, panel, 1)
    await finish(page)
    const reopened = await snapshot(page, panel)
    receipt.measurements.push({ scenario: scenario.name, kind: 'interrupted-reopen', interrupted, reverseStart, reverseMiddle, reopened, animations: reverseAnimations })
    if (!before) {
      assert.ok(reopened.rect.height > 0)
      if (scenario.reducedMotion !== 'reduce') {
        assert.ok(Math.abs(interrupted.rect.height - reverseStart.rect.height) < 1)
        assert.ok(Math.abs(Number(interrupted.opacity) - Number(reverseStart.opacity)) < 0.01)
        assert.ok(reverseMiddle.rect.height > reverseStart.rect.height && reverseMiddle.rect.height < reopened.rect.height)
      } else assert.deepEqual(reverseAnimations, [])
      assert.equal(reopened.opacity, '1')
    }
    await page.screenshot({ path: shot(`${scenario.name}-cold-expanded.png`) })
    await page.getByRole('tab', { name: 'Namzu: Polish empty states', exact: true }).evaluate(element => element.click())
    await flush(page)
    await expect(page.getByText('Keep its clock unknown.', { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: 'Namzu: Refine navigation', exact: true }).evaluate(element => element.click())
    await flush(page)
    await expect(page.getByText('Find RunPod H100 hourly prices and keep the source links.', { exact: true })).toBeVisible()
    const historyAnimations = await page.locator('.normal-transcript').evaluate(element => element.getAnimations({ subtree: true }).map(a => a.id))
    receipt.measurements.push({ scenario: scenario.name, kind: 'cached-history', animationIds: historyAnimations })
    assert.ok(historyAnimations.every(id => !id.startsWith('namzu-transcript-entry') && !id.startsWith('namzu-transcript-phase')))
    await page.getByRole('tab', { name: 'Namzu: Review message settings', exact: true }).evaluate(element => element.click())
    await flush(page)
    const baseTime = Date.parse(fixture.journalClock.user)
    await page.evaluate(({ baseTime, fixture }) => {
      window.__timingProof.setNow(baseTime + 6000)
      window.__timingProof.emit([
        { kind: 'prompt', prompt: 'Check the primary source and explain your progress.', at: baseTime },
        { kind: 'state', running: true, queued: [], at: baseTime },
        { kind: 'update', at: baseTime + 500, update: { kind: 'agent_message_chunk', messageId: 'motion-commentary', phase: 'commentary', text: 'I will check the current source and compare it with the earlier notes.' } },
        { kind: 'update', at: baseTime + 1000, update: { kind: 'agent_message', messageId: 'motion-commentary', phase: 'commentary', content: 'I will check the current source and compare it with the earlier notes.', status: 'completed', stopReason: 'tool_use' } },
        { kind: 'update', at: baseTime + 2000, update: fixture.livePending },
        { kind: 'update', at: baseTime + 2500, update: fixture.technicalReceipts[0].pendingUpdate },
        { kind: 'update', at: baseTime + 3000, update: fixture.technicalReceipts[0].completedUpdate },
        { kind: 'update', at: baseTime + 4500, update: fixture.liveCompleted },
        { kind: 'update', at: baseTime + 5000, update: { kind: 'agent_thought', blockId: 'motion-thought', status: 'pending' } },
        { kind: 'update', at: baseTime + 5100, update: { kind: 'agent_thought_chunk', blockId: 'motion-thought', text: 'I am comparing the source with the recorded earlier message.' } },
      ])
    }, { baseTime, fixture })
    await flush(page)
    await finish(page)
    await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).hover()
    await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).focus()
    await finish(page)
    await expect(page.locator('.normal-transcript .activity-trigger')).toHaveAttribute('aria-label', 'Working for 6s')
    await expect(page.locator('.normal-transcript .working[data-transcript-phase="thinking"]')).toBeVisible()
    assert.equal(await page.locator('.normal-transcript .working-elapsed').count(), 0)
    await hoverSeries(page,'.normal-transcript .message.commentary',scenario.name,'commentary')
    await hoverSeries(page,'.normal-transcript .reasoning',scenario.name,'reasoning')
    await page.getByRole('button', {name:'Toggle sidebar',exact:true}).hover()
    await page.getByRole('button', {name:'Toggle sidebar',exact:true}).focus()
    await finish(page)
    const liveLayout = await page.locator('.normal-transcript .activity-entries').evaluate(element => [...element.children].map(child => {
      const r = child.getBoundingClientRect(); const s = getComputedStyle(child)
      return { className: child.className, text: child.textContent, y: r.y, height: r.height, marginBottom: s.marginBottom, paddingBottom: s.paddingBottom, display: s.display, children: [...child.children].map(inner => {const b = inner.getBoundingClientRect(); const c = getComputedStyle(inner); return {className:inner.className,text:inner.textContent,y:b.y,height:b.height,marginBottom:c.marginBottom,paddingBottom:c.paddingBottom,display:c.display}}) }
    }))
    const textColors = await page.locator('.normal-transcript .activity-entries').evaluate(element => ({commentary:[...element.querySelectorAll('.message.commentary .message-text')].map(child=>getComputedStyle(child).color),reasoning:[...element.querySelectorAll('.reasoning .message-text')].map(child=>getComputedStyle(child).color),tools:[...element.querySelectorAll('.tool-label')].map(child=>getComputedStyle(child).color),foreground:getComputedStyle(element).color,visibleCaptions:[...element.querySelectorAll('.transcript-content-label')].filter(child=>child.checkVisibility({opacityProperty:true,visibilityProperty:true})).map(child=>child.textContent)}))
    receipt.measurements.push({ scenario: scenario.name, kind: 'live-layout', entries: liveLayout, textColors, header: await snapshot(page, '.normal-transcript .activity-trigger') })
    assert.ok(textColors.commentary.every(color=>color===textColors.foreground))
    assert.ok(textColors.reasoning.every(color=>color===textColors.foreground))
    assert.deepEqual(textColors.visibleCaptions,[])
    const commentaryContent = liveLayout[0].children.find(child => child.className.startsWith('relative min-w-0'))
    assert.ok(commentaryContent)
    const commentaryGap = liveLayout[1].y - (commentaryContent.y + commentaryContent.height)
    const reservedClock = liveLayout[0].children.find(child=>child.className==='message-time')
    assert.ok(reservedClock && reservedClock.height>0)
    assert.equal(commentaryGap, reservedClock.height+8)
    await page.screenshot({ path: shot(`${scenario.name}-live-working-thinking.png`) })
    await page.evaluate(baseTime => { window.__timingProof.setNow(baseTime + 15000); window.__timingProof.emit([
      { kind: 'update', at: baseTime + 14500, update: { kind: 'agent_thought', blockId: 'motion-thought', status: 'completed' } },
      { kind: 'update', at: baseTime + 15000, update: { kind: 'agent_message', messageId: 'motion-final', phase: 'final_answer', status: 'completed', content: 'The source is ready. The earlier notes were checked.', stopReason: 'end_turn' } },
      { kind: 'update', at: baseTime + 15000, update: { kind: 'turn_ended', stopReason: 'end_turn' } },
      { kind: 'state', at: baseTime + 15000, running: false, queued: [] },
    ]) }, baseTime)
    await flush(page)
    await finish(page)
    await expect(page.locator('.normal-transcript .activity-trigger')).toHaveAttribute('aria-label', 'Worked for 15s')
    await expect(page.getByText('The source is ready. The earlier notes were checked.', { exact: true })).toBeVisible()
    const answerInsidePanel = await page.locator('.normal-transcript .message.assistant').filter({ hasText: 'The source is ready.' }).evaluate(element => Boolean(element.closest('.turn-activity')))
    assert.equal(answerInsidePanel, false)
    await page.screenshot({ path: shot(`${scenario.name}-settled-collapsed.png`) })
    await togglePanel(page, true, scenario.name, 'settled-open')
    const settledPanel = await snapshot(page, panel)
    assert.equal(settledPanel.dataOpen, true)
    assert.equal(settledPanel.display, 'block')
    assert.equal(settledPanel.opacity, '1')
    assert.ok(settledPanel.rect.height > 0)
    const renderedBody = await page.locator('.normal-transcript .activity-entries').evaluate(element => [...element.children].map(child => {const rect=child.getBoundingClientRect();return {text:child.textContent,visible:child.checkVisibility({opacityProperty:true,visibilityProperty:true}),top:rect.top,bottom:rect.bottom,height:rect.height}}))
    for (const item of renderedBody) {
      assert.equal(item.visible, true)
      assert.ok(item.height > 0)
      assert.ok(item.bottom <= settledPanel.rect.bottom + 1)
    }
    const finalAnswerTop = await page.locator('.normal-transcript .message.assistant').filter({hasText:'The source is ready.'}).evaluate(element=>element.getBoundingClientRect().top)
    assert.ok(finalAnswerTop >= settledPanel.rect.bottom)
    await expect(page.getByText('I will check the current source and compare it with the earlier notes.', {exact:true})).toBeVisible()
    await expect(page.locator('.normal-transcript .activity-entries .tool-label').filter({hasText:'Searched the web'})).toBeVisible()
    const finalSource = source.find(item => item.path === 'transcript-motion.css').sha256.slice(0,8)
    const authoritativeScreenshot = `${scenario.name}-settled-expanded-${finalSource}-${proofId}.png`
    await page.screenshot({ path: join(artifacts, authoritativeScreenshot) })
    const screenshotSha256 = createHash('sha256').update(await readFile(join(artifacts, authoritativeScreenshot))).digest('hex')
    receipt.measurements.push({scenario:scenario.name,kind:'settled-rendered-body',panel:settledPanel,body:renderedBody,finalAnswerTop,authoritativeScreenshot,screenshotSha256})
    receipt.checks.push(`${scenario.name}: fixed clock/duration slots preserve exact row/neighbour/scroll/total-height geometry through opacity-only hover, reverse and keyboard focus for user bubble/assistant/commentary/reasoning/tool/duration/header; panel height/opacity and interrupted reopen; cached history has no admission/phase motion; live Working for6s plus actual Thinking without elapsed; settled Worked for15s with final answer outside disclosure.`)
    await context.close(); context = undefined
  }
  if (persistenceOnly) await proveDisclosurePersistence()
  if (pendingScrollOnly) await provePendingScrollRaces()
  assert.deepEqual(receipt.pageErrors, [])
  receipt.sourceAfter = await sourceFingerprint()
  receipt.sourceStayedFixed = JSON.stringify(receipt.sourceAfter) === JSON.stringify(receipt.source)
  assert.equal(receipt.sourceStayedFixed, true)
  receipt.passed = true
} finally {
  await context?.close(); await browser.close(); await server.close()
  await writeFile(join(artifacts, outputFile), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' })
}
console.log(JSON.stringify({ passed: receipt.passed, checks: receipt.checks.length, pageErrors: receipt.pageErrors.length, receipt: outputFile }))

async function proveDisclosurePersistence() {
  const scenario = 'persistence-wide-dark'
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark', reducedMotion: 'no-preference', timezoneId: 'Europe/Istanbul' })
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort())
  const page = await context.newPage()
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => receipt.pageErrors.push({ scenario, message: error.message }))
  await page.addInitScript(installFixture, { fixture: persistenceFixture(fixture), appearance: 'dark' })
  await page.goto(origin)
  await expect(page.getByText('Owner A reader checkpoint 1.1: keep this saved work available.', { exact: true })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  await page.clock.install()
  await page.clock.pauseAt(Date.now())
  const cdp = await context.newCDPSession(page)
  await cdp.send('Animation.enable')
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 })
  await ready()
  const triggers = page.locator('.normal-transcript .activity-trigger')
  assert.equal(await triggers.count(), 8)
  await triggers.nth(0).click(); await finish(page)
  await triggers.nth(1).click(); await finish(page)
  const opened = await panels()
  assert.equal(opened[0].turn, opened[1].turn)
  assert.notEqual(opened[0].key, opened[1].key, 'Two work segments in one turn must keep different manual choices.')
  assert.deepEqual(opened.map(panel => panel.open), [true, true, false, false, false, false, false, false])
  await positionReader('message-5', 24)
  const ownerA = await reader()
  assert.equal(ownerA.anchor.key, 'message-5')
  assert(ownerA.tailDistance > 48)
  await capture('owner-a-open-reading')
  await select('Namzu: Polish empty states', 'Owner B')
  const defaultsB = await panels()
  assert.deepEqual(defaultsB.map(panel => panel.key), opened.map(panel => panel.key), 'The collision fixture must expose the same disclosure keys in separate conversations.')
  assert(defaultsB.every(panel => !panel.open), 'The new owner inherited another conversation\'s explicit open choices.')
  await triggers.nth(0).click(); await finish(page)
  await triggers.nth(0).click(); await finish(page)
  await triggers.nth(1).click(); await finish(page)
  await positionReader('message-8', 11)
  const ownerB = await reader()
  await select('Namzu: Refine navigation', 'Owner A')
  const cachedA = await reader()
  assertReader(ownerA, cachedA, 'cached Owner A')
  assert.deepEqual((await panels()).map(panel => panel.open), opened.map(panel => panel.open))
  const storedA = await saved('sample-thread-1')
  const storedB = await saved('sample-thread-2')
  assert.equal(storedA.workDisclosures[opened[0].key], true)
  assert.equal(storedA.workDisclosures[opened[1].key], true)
  assert.equal(storedB.workDisclosures[opened[0].key], false, 'Explicit false must survive rather than becoming an absent/default value.')
  assert.equal(storedB.workDisclosures[opened[1].key], true)
  assert.equal(storedA.follow, false)
  assert.equal(storedB.follow, false)
  assert.ok(Math.abs(storedA.scrollTop - ownerA.scrollTop) < 1)
  assert.ok(Math.abs(storedB.scrollTop - ownerB.scrollTop) < 1)
  await capture('owner-a-cached-return')
  await page.evaluate(() => window.__timingProof.deferHistoryOnReload('sample-thread-1'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__timingProof?.deferredHistory()?.requested === true)
  await flush(page, 64)
  const loading = await page.evaluate(() => ({ gate: window.__timingProof.deferredHistory(), state: document.querySelector('.transcript')?.dataset.historyState, headers: document.querySelectorAll('.normal-transcript .activity-trigger').length, ownerA: JSON.parse(localStorage.getItem('namzu.workspace.presentation:sample-thread-1')), ownerB: JSON.parse(localStorage.getItem('namzu.workspace.presentation:sample-thread-2')) }))
  assert.equal(loading.gate.sessionId, 'sample-thread-1')
  assert.equal(loading.gate.released, false)
  assert.equal(loading.state, 'loading')
  assert.equal(loading.headers, 0, 'The deferred cold read must actually leave the authoritative work tree unavailable.')
  assert.deepEqual(loading.ownerA.workDisclosures, storedA.workDisclosures)
  assert.deepEqual(loading.ownerB.workDisclosures, storedB.workDisclosures)
  assert.equal(loading.ownerA.scrollTop, storedA.scrollTop, 'An empty loading tree overwrote the saved reader position.')
  await capture('owner-a-cold-loading-deferred')
  await page.evaluate(() => window.__timingProof.releaseHistory())
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 })
  await ready()
  const reloadedA = await reader()
  assertReader(ownerA, reloadedA, 'authoritative cold Owner A after explicit deferred history release')
  assert.deepEqual((await panels()).map(panel => panel.open), opened.map(panel => panel.open))
  assert.deepEqual((await saved('sample-thread-1')).workDisclosures, storedA.workDisclosures)
  assert.deepEqual((await saved('sample-thread-2')).workDisclosures, storedB.workDisclosures)
  await capture('owner-a-cold-reloaded')
  await select('Namzu: Polish empty states', 'Owner B')
  assertReader(ownerB, await reader(), 'Owner B after other-owner renderer reload')
  assert.deepEqual((await panels()).map(panel => panel.open), [false, true, false, false, false, false, false, false])
  await capture('owner-b-explicit-false-return')
  await select('Namzu: Refine navigation', 'Owner A')
  assertReader(ownerA, await reader(), 'final Owner A')
  const animationIds = await page.locator('.normal-transcript').evaluate(element => element.getAnimations({ subtree: true }).map(animation => animation.id))
  assert(animationIds.every(id => !id.startsWith('namzu-transcript-entry') && !id.startsWith('namzu-transcript-phase')))
  receipt.measurements.push({ scenario, kind: 'owner-disclosure-reader-restoration', opened, ownerA, ownerB, cachedA, loading: { gate: loading.gate, state: loading.state, headers: loading.headers }, reloadedA, storedA, storedB, cachedAdmissionAnimationIds: animationIds, controlledHistoryRelease: true, actualUserConversationRead: false })
  receipt.checks.push('Actual App: two same-turn work panels retain distinct explicit open choices across a cached-tab return; a different conversation with identical keys retains explicit false and its own reader anchor.')
  receipt.checks.push('Actual App reload: a controlled deferred authoritative history promise exposes an empty loading tree without losing saved choices or consuming scroll restoration; release restores the exact same reader message, offset, follow=false and open panels.')
  await context.close(); context = undefined

  async function ready() {
    await expect(page.locator('.transcript')).toHaveAttribute('data-history-state', 'authoritative')
    await expect(page.locator('.normal-transcript .activity-trigger')).toHaveCount(8)
    await flush(page, 64); await finish(page)
  }
  async function select(label, owner) {
    await page.getByRole('tab', { name: label, exact: true }).click()
    await expect(page.getByText(`${owner} reader checkpoint 1.1: keep this saved work available.`, { exact: true })).toBeVisible()
    await ready()
  }
  async function panels() {
    return page.locator('.normal-transcript [data-activity-turn]').evaluateAll(items => items.map(item => { const first = item.querySelector('.activity-entries [data-transcript-entry-key]'); const trigger = item.querySelector(':scope > .activity-trigger'); const turn = Number(item.dataset.activityTurn); return { turn, firstKey: first?.dataset.transcriptEntryKey, key: JSON.stringify([turn, first?.dataset.transcriptEntryKey]), open: trigger.getAttribute('aria-expanded') === 'true', label: trigger.getAttribute('aria-label') } }))
  }
  async function positionReader(key, offset) {
    await page.locator('.transcript').evaluate((element, { key, offset }) => {
      const anchor = [...element.querySelectorAll('.message[data-transcript-entry-key]')].find(item => item.dataset.transcriptEntryKey === key)
      if (!anchor) throw new Error('The requested public reader anchor is missing.')
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }))
      element.scrollTop += anchor.getBoundingClientRect().top - element.getBoundingClientRect().top + offset
      element.dispatchEvent(new Event('scroll'))
    }, { key, offset })
    await flush(page, 64); await finish(page)
  }
  async function reader() {
    return page.locator('.transcript').evaluate(element => {
      const viewport = element.getBoundingClientRect()
      const anchor = [...element.querySelectorAll('.normal-transcript .message[data-transcript-entry-key]')].find(item => { const rect = item.getBoundingClientRect(); return rect.bottom > viewport.top && rect.top < viewport.bottom && item.checkVisibility({ opacityProperty: true, visibilityProperty: true }) })
      if (!anchor) throw new Error('No public reader message intersects the viewport.')
      return { scrollTop: element.scrollTop, tailDistance: element.scrollHeight - element.clientHeight - element.scrollTop, anchor: { key: anchor.dataset.transcriptEntryKey, phase: anchor.dataset.messagePhase ?? null, topOffset: anchor.getBoundingClientRect().top - viewport.top, textPrefix: anchor.textContent.slice(0, 90) } }
    })
  }
  function assertReader(expected, actual, where) {
    assert.equal(actual.anchor.key, expected.anchor.key, `${where}: reader message identity changed.`)
    assert.equal(actual.anchor.phase, expected.anchor.phase)
    assert.equal(actual.anchor.textPrefix, expected.anchor.textPrefix, `${where}: another conversation body was restored.`)
    assert.ok(Math.abs(actual.anchor.topOffset - expected.anchor.topOffset) < 1, `${where}: reader offset changed from ${expected.anchor.topOffset} to ${actual.anchor.topOffset}.`)
    assert.ok(Math.abs(actual.scrollTop - expected.scrollTop) < 1, `${where}: scrollTop changed from ${expected.scrollTop} to ${actual.scrollTop}.`)
    assert(actual.tailDistance > 48, `${where}: the reader unexpectedly followed to the end.`)
  }
  async function saved(id) { return page.evaluate(id => JSON.parse(localStorage.getItem(`namzu.workspace.presentation:${id}`)), id) }
  async function capture(stage) {
    const filename = `persistence-${sourceKey}-${proofId}-${stage}.png`
    await page.screenshot({ path: join(artifacts, filename) })
    receipt.measurements.push({ scenario, kind: 'persistence-screenshot', stage, authoritativeScreenshot: filename, screenshotSha256: createHash('sha256').update(await readFile(join(artifacts, filename))).digest('hex') })
  }
}

async function provePendingScrollRaces() {
  for (const action of ['cold-navigation', 'wheel', 'keyboard', 'disclosure', 'programmatic-scroll']) {
    const scenario = `pending-${action}`
    context = await browser.newContext({viewport:{width:1280,height:900},colorScheme:'dark',reducedMotion:'reduce',timezoneId:'Europe/Istanbul'})
    await context.route('**/*',route=>new URL(route.request().url()).origin===new URL(origin).origin?route.continue():route.abort())
    const page = await context.newPage()
    page.setDefaultTimeout(12000)
    page.on('pageerror',error=>receipt.pageErrors.push({scenario,message:error.message}))
    await page.addInitScript(installFixture,{fixture:persistenceFixture(fixture),appearance:'dark'})
    await page.goto(origin)
    await expect(page.getByText('Owner A reader checkpoint 1.1: keep this saved work available.',{exact:true})).toBeVisible()
    await page.evaluate(()=>document.fonts.ready)
    await page.clock.install(); await page.clock.pauseAt(Date.now())
    await ready()
    await page.getByRole('button',{name:'Toggle sidebar',exact:true}).click()
    await flush(page); await finish(page)
    await page.locator('.normal-transcript .activity-trigger').nth(0).click()
    await page.locator('.normal-transcript .activity-trigger').nth(1).click()
    await setupReader('message-5',24)
    const original = await reader()
    await selectB()
    await setupReader('message-8',11)
    const originalB = await reader()
    await page.getByRole('tab',{name:'Namzu: Refine navigation',exact:true}).click()
    await ready()
    compareReader(original,await reader(),'initial cached A')
    const savedA = await saved('sample-thread-1')
    assert.equal(savedA.follow,false)
    assert.ok(Math.abs(savedA.scrollTop-original.scrollTop)<1)
    let held, manipulated, after, savedAfter, inputEvidence
    if (action==='cold-navigation') {
      await page.evaluate(()=>window.__timingProof.deferHistoryOnReload('sample-thread-1'))
      await page.reload({waitUntil:'domcontentloaded'})
      await page.evaluate(()=>window.__timingProof.waitForHistoryRequest())
      await flush(page,64)
      held = await status()
      assert.equal(held.state,'loading')
      assert.equal(held.headers,0)
      assert.equal(held.scrollTop,0)
      assert.equal(held.saved.scrollTop,savedA.scrollTop)
      await selectB()
      savedAfter = await saved('sample-thread-1')
      assert.equal(savedAfter.scrollTop,savedA.scrollTop,'Navigating away before cold history returned replaced A saved offset with the clamped loading position.')
      assert.equal(savedAfter.follow,savedA.follow)
      const beforeReleaseB = await reader()
      await page.evaluate(()=>window.__timingProof.releaseHistory())
      await flush(page,64); await finish(page)
      compareReader(beforeReleaseB,await reader(),'late A read while B selected')
      assert.equal((await saved('sample-thread-1')).scrollTop,savedA.scrollTop)
      await page.getByRole('tab',{name:'Namzu: Refine navigation',exact:true}).click()
      await ready()
      after = await reader()
      compareReader(original,after,'A after held read was retired by navigation')
    } else {
      await selectB()
      await page.getByRole('button',{name:'Close tab Refine navigation',exact:true}).click()
      await flush(page,64)
      await page.evaluate(()=>window.__timingProof.deferHistory('sample-thread-1'))
      await page.locator('.sidebar-recents [data-session-id="sample-thread-1"] .sidebar-conversation-button').click()
      await page.evaluate(()=>window.__timingProof.waitForHistoryRequest())
      await flush(page,64); await finish(page)
      held = await status()
      assert.equal(held.state,'saved','The user race must expose retained messages while authoritative history is held.')
      assert.equal(held.headers,8)
      assert.equal(held.saved.scrollTop,savedA.scrollTop)
      if(action==='wheel') {
        const viewport = await page.locator('.transcript').boundingBox()
        await page.mouse.move(viewport.x+viewport.width/2,viewport.y+viewport.height/2)
        await armUserScroll()
        await page.mouse.wheel(0,-180)
        inputEvidence = await page.evaluate(()=>window.__pendingScrollProof)
        assert.equal(inputEvidence[0].trusted,true)
        assert.equal(inputEvidence[1].trusted,true)
        await flush(page,64); await finish(page)
      } else if(action==='keyboard') {
        const visibleKey = await page.locator('.transcript').evaluate(element=>{
          const viewport=element.getBoundingClientRect()
          const message=[...element.querySelectorAll('.message[data-transcript-entry-key]')].find(message=>{const clock=message.querySelector('.message-time');if(!clock)return false;const r=clock.getBoundingClientRect();return r.top>=viewport.top&&r.bottom<=viewport.bottom})
          if(!message)throw new Error('No visible known clock for real keyboard scrolling.')
          return message.dataset.transcriptEntryKey
        })
        await page.locator(`[data-transcript-entry-key="${visibleKey}"] .message-time`).focus()
        await armUserScroll()
        await page.keyboard.press('PageUp')
        inputEvidence = await page.evaluate(()=>window.__pendingScrollProof)
        assert.equal(inputEvidence[0].trusted,true)
        assert.equal(inputEvidence[1].trusted,true)
        await flush(page,64); await finish(page)
      } else if(action==='disclosure') {
        await page.locator('.normal-transcript .activity-trigger').nth(2).click()
        await flush(page,64); await finish(page)
      } else {
        await page.locator('.transcript').evaluate(element=>{element.scrollTop=400;element.dispatchEvent(new Event('scroll'))})
        await flush(page,64); await finish(page)
      }
      manipulated = await reader()
      assert.ok(Math.abs(manipulated.scrollTop-original.scrollTop)>10,'The race fixture did not expose a different newer reader position.')
      const choicesBeforeRelease = await choices()
      await page.evaluate(()=>window.__timingProof.releaseHistory())
      await ready()
      after = await reader()
      receipt.measurements.push({scenario,kind:'pending-scroll-before-assert',action,held,manipulated,after})
      if(action==='programmatic-scroll') compareReader(original,after,'programmatic scroll must not retire the saved restoration')
      else {
        compareReader(manipulated,after,`${action}: reader action supersedes pending restoration`)
        assert.deepEqual(await choices(),choicesBeforeRelease,'The authoritative read replaced newer manual work choices.')
        await selectB()
        savedAfter=await saved('sample-thread-1')
        assert.ok(Math.abs(savedAfter.scrollTop-manipulated.scrollTop)<1,'Leaving after release did not persist the newer reader position.')
        if(action==='disclosure') assert.equal(Object.values(savedAfter.workDisclosures).filter(Boolean).length,3)
        await page.getByRole('tab',{name:'Namzu: Refine navigation',exact:true}).click();await ready()
        compareReader(manipulated,await reader(),`${action}: subsequent cached return`)
      }
    }
    receipt.measurements.push({scenario,kind:'pending-scroll-race',action,original,originalB,savedA,held,manipulated,after,savedAfter,inputEvidence,userInput:action==='wheel'?'Playwright mouse wheel':action==='keyboard'?'Playwright PageUp':action==='disclosure'?'Playwright manual work trigger click':'none',directProductStorageWrites:0})
    receipt.checks.push(`${scenario}: ${action==='cold-navigation'?'navigation before held cold history preserves the original saved reader despite generation change':action==='programmatic-scroll'?'plain programmatic scroll does not retire pending saved restoration':'actual reader input supersedes pending restoration and survives authoritative release/cached return'}.`)
    await context.close();context=undefined

    async function ready(){await expect(page.locator('.transcript')).toHaveAttribute('data-history-state','authoritative');await expect(page.locator('.normal-transcript .activity-trigger')).toHaveCount(8);await flush(page,64);await finish(page)}
    async function selectB(){await page.getByRole('tab',{name:'Namzu: Polish empty states',exact:true}).click();await ready();await expect(page.getByText('Owner B reader checkpoint 1.1: keep this saved work available.',{exact:true})).toBeVisible()}
    async function setupReader(key,offset){await page.locator('.transcript').evaluate((element,{key,offset})=>{const anchor=[...element.querySelectorAll('.message[data-transcript-entry-key]')].find(item=>item.dataset.transcriptEntryKey===key);if(!anchor)throw new Error('Missing setup reader anchor');element.dispatchEvent(new WheelEvent('wheel',{deltaY:-1,bubbles:true}));element.scrollTop+=anchor.getBoundingClientRect().top-element.getBoundingClientRect().top+offset;element.dispatchEvent(new Event('scroll'))},{key,offset});await flush(page,64);await finish(page)}
    async function reader(){return page.locator('.transcript').evaluate(element=>{const viewport=element.getBoundingClientRect();const anchor=[...element.querySelectorAll('.message[data-transcript-entry-key]')].find(item=>{const r=item.getBoundingClientRect();return r.bottom>viewport.top&&r.top<viewport.bottom&&item.checkVisibility({opacityProperty:true,visibilityProperty:true})});if(!anchor)throw new Error('Missing visible reader anchor');return {scrollTop:element.scrollTop,tailDistance:element.scrollHeight-element.clientHeight-element.scrollTop,anchor:{key:anchor.dataset.transcriptEntryKey,phase:anchor.dataset.messagePhase??null,topOffset:anchor.getBoundingClientRect().top-viewport.top,textPrefix:anchor.textContent.slice(0,90)}}})}
    function compareReader(expected,actual,where){assert.equal(actual.anchor.key,expected.anchor.key,`${where}: reader identity`);assert.equal(actual.anchor.phase,expected.anchor.phase);assert.equal(actual.anchor.textPrefix,expected.anchor.textPrefix);assert.ok(Math.abs(actual.anchor.topOffset-expected.anchor.topOffset)<1,`${where}: reader anchor offset ${expected.anchor.topOffset}→${actual.anchor.topOffset}`);assert.ok(Math.abs(actual.scrollTop-expected.scrollTop)<1,`${where}: scrollTop ${expected.scrollTop}→${actual.scrollTop}`);assert.ok(actual.tailDistance>48)}
    async function saved(id){return page.evaluate(id=>JSON.parse(localStorage.getItem(`namzu.workspace.presentation:${id}`)),id)}
    async function choices(){return page.locator('.normal-transcript .activity-trigger').evaluateAll(items=>items.map(item=>item.getAttribute('aria-expanded')==='true'))}
    async function status(){return page.evaluate(()=>({gate:window.__timingProof.deferredHistory(),state:document.querySelector('.transcript').dataset.historyState,headers:document.querySelectorAll('.normal-transcript .activity-trigger').length,scrollTop:document.querySelector('.transcript').scrollTop,saved:JSON.parse(localStorage.getItem('namzu.workspace.presentation:sample-thread-1'))}))}
    async function armUserScroll(){await page.locator('.transcript').evaluate(element=>{window.__pendingScrollProof=Promise.all(['scroll','scrollend'].map(type=>new Promise(resolve=>element.addEventListener(type,event=>resolve({type,trusted:event.isTrusted,scrollTop:element.scrollTop}),{once:true}))))})}
  }
}
