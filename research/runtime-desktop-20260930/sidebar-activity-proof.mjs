/** Sidebar activity proof using explicit owned-page events and existing development sample IDs. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? '.')
const origin = process.env.NAMZU_DESKTOP_DEV_URL ?? 'http://127.0.0.1:5173/'
const artifacts = join(repo, 'research/runtime-desktop-20260930/artifacts')
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { chromium, expect } = require('@playwright/test')
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1609, height: 973 }, colorScheme: 'dark' })
const page = await context.newPage()
const captures = [], faults = [], transitions = []
const first = 'sample-thread-1', second = 'sample-thread-2', errorId = 'sample-thread-3', shellId = 'sample-thread-4'
const sidebar = () => page.getByRole('complementary', { name: 'Projects and conversations', exact: true })
const projects = () => sidebar().locator('.sidebar-project-navigation')
const recents = () => sidebar().getByRole('region', { name: 'Recent conversations', exact: true })
const recentList = () => recents().getByRole('list', { name: 'Recent conversations', exact: true })
const projectRow = id => projects().locator(`[data-session-id="${id}"]`)
const recentRow = id => recentList().locator(`[data-session-id="${id}"]`)
const bothRows = id => sidebar().locator(`[data-session-id="${id}"]`)
const running = id => bothRows(id).locator('.thread-running-indicator')
page.setDefaultTimeout(20000)
page.on('pageerror', error => faults.push(error.message))
await context.route('**/*', route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort())
await mkdir(artifacts, { recursive: true })

await page.addInitScript(() => {
  let api
  const qa = window.__sidebarActivityQa = { listeners: new Set(), records: {}, reads: [], jobs: [], opened: [], events: [], revisions: {}, expanded: false, forbidden: { send: 0, cancel: 0, approve: 0, stopJob: 0, pluginChanges: 0 } }
  const times = [14, 16, 13, 15, 12, 17]
  Object.defineProperty(window, 'namzu', {
    configurable: true,
    get: () => api,
    set(value) {
      api = value
      const subscribe = value.onEvent.bind(value), catalogue = value.conversations.bind(value), open = value.openConversation.bind(value), attachments = value.attachments.bind(value)
      value.onEvent = listener => {
        qa.listeners.add(listener)
        const remove = subscribe(listener)
        return () => { qa.listeners.delete(listener); remove() }
      }
      value.conversations = async projectId => {
        qa.reads.push(projectId)
        const rows = await catalogue(projectId)
        if (qa.expanded && projectId === 'sample-app') for (let index = 1; index <= 6; index++) rows.push({ id: `qa-synthetic-extra-${index}`, projectId, title: `Explicit synthetic catalogue row ${index}`, updatedAt: `2026-09-${String(28 - index).padStart(2, '0')}T09:00:00.000Z` })
        return rows.map(row => {
          const index = Number(row.id.split('-').at(-1)) - 1
          const record = { ...row, ...(row.id.startsWith('sample-thread-') ? { updatedAt: `2026-09-30T${times[index]}:00:00.000Z` } : {}), ...(row.id === 'sample-thread-1' ? { title: 'QA synthetic long conversation title with an intentionally extended ending to verify ellipsis and a stable status slot' } : {}) }
          qa.records[row.id] = structuredClone(record)
          return record
        })
      }
      value.openConversation = async (projectId, sessionId) => { qa.opened.push({ projectId, sessionId }); return await open(projectId, sessionId) }
      value.attachments = async ownerId => ownerId.startsWith('qa-synthetic-extra-') ? [] : await attachments(ownerId)
      value.jobs = async sessionId => {
        qa.jobs.push(sessionId)
        return sessionId === 'sample-thread-4' ? [{ id: 'qa-synthetic-background-shell', command: 'Explicit synthetic server fixture; no process was started', status: 'running', startedAt: 0 }] : []
      }
      for (const [method, counter] of [['send', 'send'], ['cancel', 'cancel'], ['approve', 'approve'], ['stopJob', 'stopJob'], ['setPluginEnabled', 'pluginChanges']]) {
        value[method] = async () => { qa.forbidden[counter]++; throw new Error(`This proof must not invoke ${method}.`) }
      }
      qa.emit = event => {
        const sessionId = event.kind === 'permission' ? event.request.sessionId : event.sessionId
        const revision = (qa.revisions[sessionId] ?? 0) + 1
        qa.revisions[sessionId] = revision
        const wire = { ...event, revision }
        qa.events.push(structuredClone(wire))
        for (const listener of qa.listeners) listener(structuredClone(wire))
      }
    },
  })
})

async function settle() {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished))
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  })
}
async function emit(event) { await page.evaluate(event => window.__sidebarActivityQa.emit(event), event) }
async function expectState(id, { spins = 0, approval = false, error = false, description } = {}) {
  await expect(projectRow(id)).toHaveCount(1)
  await expect(recentRow(id)).toHaveCount(1)
  await expect(running(id)).toHaveCount(spins)
  await expect(bothRows(id).locator('svg[aria-label="Approval needed"]')).toHaveCount(approval ? 2 : 0)
  await expect(bothRows(id).locator('.connection-dot.error[aria-label="Needs attention"]')).toHaveCount(error ? 2 : 0)
  const statusIds = await bothRows(id).locator('button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-describedby')))
  const descriptions = await bothRows(id).locator('button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-describedby')?.split(/\s+/).map(id => document.getElementById(id)?.textContent).join(' ').trim() || null))
  assert.deepEqual(descriptions, [description ?? null, description ?? null])
  if (description) {
    assert.equal(new Set(statusIds).size, 2, 'duplicate conversation presentations use distinct description IDs')
    await expect(projectRow(id).getByRole('button')).toHaveAccessibleDescription(description)
    await expect(recentRow(id).getByRole('button')).toHaveAccessibleDescription(description)
  }
  transitions.push({ id, spins, approval, error, descriptions, statusIds })
}
async function openSession(id) {
  await projectRow(id).getByRole('button').click()
  await expect(projectRow(id).getByRole('button')).toHaveAttribute('aria-current', 'page')
  await expect(recentRow(id).getByRole('button')).toHaveAttribute('aria-current', 'page')
  await settle()
}
async function rowMeasurements(id) {
  await settle()
  return await bothRows(id).evaluateAll(nodes => nodes.map(node => {
    const row = node.querySelector('.conversation-row'), title = node.querySelector('.conversation-row-title'), state = node.querySelector('.conversation-row-state')
    const rect = node => node.getBoundingClientRect().toJSON()
    return { collection: node.closest('.sidebar-recents') ? 'recents' : 'projects', row: rect(row), title: rect(title), slot: rect(state), titleOverflow: getComputedStyle(title).textOverflow, titleClientWidth: title.clientWidth, titleScrollWidth: title.scrollWidth, slotWidth: getComputedStyle(state).width }
  }))
}
async function assertStable(id, before) {
  const after = await rowMeasurements(id)
  assert.deepEqual(after.map(value => value.collection), before.map(value => value.collection))
  for (let index = 0; index < before.length; index++) {
    for (const field of ['x', 'y', 'width', 'height']) assert.equal(after[index].title[field], before[index].title[field], `title ${field} is stable in ${after[index].collection}`)
    for (const field of ['x', 'width']) assert.equal(after[index].slot[field], before[index].slot[field], `trailing slot ${field} is stable in ${after[index].collection}`)
    // The glyph is deliberately12px while age text has its own line height; compare its centre.
    assert.equal(after[index].slot.y + after[index].slot.height / 2, before[index].slot.y + before[index].slot.height / 2, `trailing indicator centre is stable in ${after[index].collection}`)
    assert.equal(after[index].row.height, before[index].row.height, 'replacing age with a status does not resize the row')
    assert.equal(after[index].slotWidth, '28px')
    assert.equal(after[index].titleOverflow, 'ellipsis')
    assert.ok(after[index].titleScrollWidth > after[index].titleClientWidth, 'the intentionally long title truncates')
  }
  return after
}
async function recentIds() { return await recentList().locator('[data-session-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-session-id'))) }
async function capture(name, { reduced = false } = {}) {
  await settle()
  const value = await page.evaluate(() => {
    const sidebar = document.querySelector('#namzu-sidebar'), project = sidebar.querySelector('.sidebar-project-navigation'), recent = sidebar.querySelector('.sidebar-recents')
    const rect = node => node.getBoundingClientRect().toJSON()
    const qa = window.__sidebarActivityQa
    return {
      width: innerWidth, height: innerHeight, dark: document.documentElement.classList.contains('dark'), reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      overflow: document.documentElement.scrollWidth > innerWidth,
      recentsOutsideProjects: !project.contains(recent), recentsFollowsProjects: Boolean(project.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING),
      recentIds: [...recent.querySelectorAll('[data-session-id]')].map(node => node.dataset.sessionId),
      rows: [...sidebar.querySelectorAll('[data-session-id]')].map(node => {
        const row = node.querySelector('.conversation-row'), title = node.querySelector('.conversation-row-title'), state = node.querySelector('.conversation-row-state'), indicator = node.querySelector('.thread-running-indicator')
        const spin = indicator ? getComputedStyle(indicator) : null
        const statusId = node.querySelector('button').getAttribute('aria-describedby')
        return { id: node.dataset.sessionId, collection: node.closest('.sidebar-recents') ? 'recents' : 'projects', description: statusId ? document.getElementById(statusId)?.textContent : null, statusId, active: node.querySelector('button').getAttribute('aria-current'), row: rect(row), title: rect(title), slot: rect(state), slotWidth: getComputedStyle(state).width, titleOverflow: getComputedStyle(title).textOverflow, running: spin ? { role: indicator.getAttribute('role'), label: indicator.getAttribute('aria-label'), ariaHidden: indicator.getAttribute('aria-hidden'), cssWidth: spin.width, cssHeight: spin.height, color: spin.color, animation: spin.animationName, duration: spin.animationDuration, iterations: spin.animationIterationCount } : null }
      }),
      api: { reads: qa.reads, jobs: qa.jobs, opened: qa.opened, events: qa.events, forbidden: qa.forbidden },
    }
  })
  assert.equal(value.overflow, false)
  assert.equal(value.recentsOutsideProjects, true)
  assert.equal(value.recentsFollowsProjects, true)
  for (const row of value.rows.filter(row => row.running)) {
    assert.equal(row.slotWidth, '28px')
    assert.equal(row.running.cssWidth, '12px')
    assert.equal(row.running.cssHeight, '12px')
    assert.equal(row.running.role, 'img')
    assert.equal(row.running.label, 'Running')
    assert.equal(row.running.ariaHidden, 'false')
    assert.equal(row.running.animation, reduced ? 'none' : 'thread-running-turn')
    if (!reduced) assert.equal(row.running.iterations, 'infinite')
  }
  if (reduced) assert.equal(value.reduced, true)
  await writeFile(join(artifacts, `sidebar-activity-${name}.json`), JSON.stringify(value, null, 2) + '\n')
  await page.screenshot({ path: join(artifacts, `sidebar-activity-${name}.png`) })
  captures.push({ name, ...value })
}

try {
  await page.goto(new URL('preview', origin).href)
  await expect(page.getByRole('status', { name: 'Design preview', exact: true })).toBeVisible()
  await expect(projectRow(first)).toHaveCount(1)
  for (const [project, id] of [['Sample docs', 'sample-thread-4'], ['Sample workspace', 'sample-thread-6'], ['Sample app', first]]) {
    await sidebar().getByRole('button', { name: `Open ${project}`, exact: true }).click()
    await expect(projectRow(id)).toHaveCount(1)
  }
  await expect(recentList().locator('[data-session-id]')).toHaveCount(6)
  const expectedRecents = await page.evaluate(() => Object.values(window.__sidebarActivityQa.records).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map(record => record.id))
  assert.deepEqual(await recentIds(), expectedRecents)
  await expectState(first)
  const baseline = await rowMeasurements(first)
  await openSession(first)
  await emit({ kind: 'state', sessionId: first, running: true, queued: [] })
  await expectState(first, { spins: 2, description: 'Running' })
  const firstRunning = await assertStable(first, baseline)
  await openSession(second)
  await expectState(first, { spins: 2, description: 'Running' })
  await emit({ kind: 'state', sessionId: second, running: true, queued: [] })
  await expectState(second, { spins: 2, description: 'Running' })
  await emit({ kind: 'state', sessionId: errorId, running: false, queued: [], error: 'Explicit synthetic failure; no model was called.' })
  await expectState(errorId, { error: true, description: 'Needs attention' })
  await openSession(shellId)
  await page.waitForFunction(id => window.__sidebarActivityQa.jobs.includes(id), shellId)
  await expectState(shellId)
  await expectState(first, { spins: 2, description: 'Running' })
  await expectState(second, { spins: 2, description: 'Running' })
  assert.deepEqual(await recentIds(), expectedRecents, 'navigation does not replace update-time order with visit order')
  await capture('wide-dark-running-and-recents')

  await emit({ kind: 'permission', request: { id: 'qa-synthetic-approval', sessionId: first, projectId: 'sample-app', calls: [{ id: 'qa-synthetic-call', name: 'QA explicit synthetic action', input: { preview: true }, isDestructive: false }] } })
  await expectState(first, { approval: true, description: 'Approval needed' })
  const firstApproval = await assertStable(first, baseline)
  await expectState(second, { spins: 2, description: 'Running' })
  await capture('wide-dark-approval-priority')
  await emit({ kind: 'permission-cleared', sessionId: first, requestId: 'qa-synthetic-approval' })
  await expectState(first, { spins: 2, description: 'Running' })
  await emit({ kind: 'state', sessionId: first, running: false, queued: [] })
  await expectState(first)
  const firstStopped = await assertStable(first, baseline)
  await expectState(second, { spins: 2, description: 'Running' })
  await emit({ kind: 'state', sessionId: second, running: false, queued: [] })
  await expectState(second)
  await expectState(errorId, { error: true, description: 'Needs attention' })

  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: 'Profile', exact: true }).click()
  await page.getByRole('menuitemradio', { name: 'Light', exact: true }).click()
  await page.setViewportSize({ width: 600, height: 540 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await emit({ kind: 'state', sessionId: first, running: true, queued: [] })
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click()
  await expect(sidebar()).toHaveClass(/\bopen\b/)
  await recentRow(first).scrollIntoViewIfNeeded()
  await expectState(first, { spins: 2, description: 'Running' })
  await capture('narrow-light-static-running-reduced', { reduced: true })
  await emit({ kind: 'state', sessionId: first, running: false, queued: [] })
  await expectState(first)
  await page.setViewportSize({ width: 1609, height: 973 })
  await page.evaluate(() => { window.__sidebarActivityQa.expanded = true })
  for (const project of ['Sample docs', 'Sample app']) await sidebar().getByRole('button', { name: `Open ${project}`, exact: true }).click()
  await page.waitForFunction(() => Object.keys(window.__sidebarActivityQa.records).length === 12)
  await expect(recentList().locator('[data-session-id]')).toHaveCount(10)
  const outside = 'qa-synthetic-extra-6'
  await expect(bothRows(outside)).toHaveCount(0)
  await emit({ kind: 'state', sessionId: outside, running: true, queued: [] })
  await expectState(outside, { spins: 2, description: 'Running' })
  await expect(recentList().locator('[data-session-id]')).toHaveCount(11)
  await emit({ kind: 'state', sessionId: outside, running: false, queued: [] })
  await expect(bothRows(outside)).toHaveCount(0)
  await expect(recentList().locator('[data-session-id]')).toHaveCount(10)
  const capRetention = { fixture: 'Six additional synthetic catalogue records, admitted only into the owned page after the three captures.', id: outside, projectOrdinal: 9, recentsOrdinal: 12, hiddenBefore: true, presentInBothWhileRunning: true, hiddenAfterStop: true }
  const counts = await page.evaluate(() => ({ reads: window.__sidebarActivityQa.reads, jobs: window.__sidebarActivityQa.jobs, opened: window.__sidebarActivityQa.opened, events: window.__sidebarActivityQa.events, forbidden: window.__sidebarActivityQa.forbidden, listeners: window.__sidebarActivityQa.listeners.size }))
  assert.deepEqual(counts.forbidden, { send: 0, cancel: 0, approve: 0, stopJob: 0, pluginChanges: 0 })
  assert.deepEqual(faults, [])
  const receipt = { passed: true, scope: 'Browser-only localhost preview in one owned isolated context. The three captures retain existing sample conversation IDs; titles/dates, revisioned state/permission events, and one running-background-job result are explicit synthetic fixtures. A final cap check adds six synthetic catalogue records only in the owned page. No native session, model request, process launch, approval decision, plugin/scheduler mutation or real agent progress is claimed.', checks: ['Recents outside Projects, using actual loaded catalogue records sorted by updatedAt rather than visit order', 'Same session running/stop updates both Projects and Recents', 'Concurrent inactive sessions remain scoped while navigating', 'Background shell alone does not create a turn spinner', 'Approval priority hides running indicator; synthetic failure remains needs-attention without fabricated success', 'Long title and fixed28px trailing slot remain stable across idle/running/approval/stop', 'Neutral12px running icon rotates normally and is static under reduced motion', 'A running synthetic session outside both default list caps remains visible, then leaves both after stopping'], expectedRecents, capRetention, geometry: { baseline, firstRunning, firstApproval, firstStopped }, transitions, counts, captures, pageErrors: faults }
  await writeFile(join(artifacts, 'sidebar-activity-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, captures: captures.length, receipt: join(artifacts, 'sidebar-activity-receipt.json') }))
} catch (error) {
  await writeFile(join(artifacts, 'sidebar-activity-receipt.json'), JSON.stringify({ passed: false, scope: 'Isolated localhost preview with explicit synthetic events only.', error: String(error), transitions, captures, pageErrors: faults }, null, 2) + '\n')
  throw error
} finally { await context.close(); await browser.close() }
