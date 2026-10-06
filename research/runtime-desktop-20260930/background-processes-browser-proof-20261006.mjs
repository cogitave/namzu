/** Real renderer, owned synthetic process responses; no native/model/guest actions. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
const repo = resolve(process.argv[2] ?? '.')
const origin = process.env.NAMZU_DESKTOP_DEV_URL ?? 'http://127.0.0.1:5173/preview'
const artifacts = join(repo, 'research/runtime-desktop-20260930/artifacts')
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { chromium, expect } = require('@playwright/test')
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: 'dark' })
const page = await context.newPage()
page.setDefaultTimeout(12000)
const faults = []
page.on('pageerror', error => faults.push(error.message))
await context.route('**/*', route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort())
await mkdir(artifacts, { recursive: true })
const receipt = { passed: false, realRenderer: true, browserOnly: true, nativeActions: 0, modelRequests: 0, computerActions: 0, checks: [], frames: {} }
await page.addInitScript(() => {
  let api
  const state = { calls: [], actions: [], gates: {}, plans: {}, pollError: '', intervals: new Map(), nextTimer: 1000000,
    jobs: [
      { id: 'server', command: 'npm run dev -- --host 127.0.0.1 --project a-very-long-project-command-for-layout', status: 'running', startedAt: 1 },
      { id: 'watcher', command: 'pnpm watch', status: 'running', startedAt: 2 },
      { id: 'build', command: 'pnpm build', status: 'exited', startedAt: 3, exitCode: 0 },
      { id: 'lint', command: 'pnpm lint', status: 'exited', startedAt: 4, exitCode: 7 },
      { id: 'unknown-exit', command: 'node worker', status: 'exited', startedAt: 5 },
    ] }
  const interval = window.setInterval.bind(window), clear = window.clearInterval.bind(window)
  window.setInterval = (callback, delay, ...args) => {
    if (delay !== 2000) return interval(callback, delay, ...args)
    const id = ++state.nextTimer
    state.intervals.set(id, () => callback(...args))
    return id
  }
  window.clearInterval = id => state.intervals.has(id) ? state.intervals.delete(id) : clear(id)
  const held = async (key, result) => {
    if (!state.plans[key]) return result
    delete state.plans[key]
    return new Promise((resolve, reject) => { state.gates[key] = { resolve: value => resolve(value === undefined ? result : value), reject } })
  }
  Object.defineProperty(window, 'namzu', { configurable: true, get: () => api, set(value) {
    api = value
    const base = { ...value }
    const workspace = { windowId: 'background-proof-window', sequence: 0, homeGroupId: 'background-proof-group',
      layout: { version: 1, revision: 0, windows: [{ id: 'background-proof-window', focusedGroupId: 'background-proof-group',
        root: { kind: 'group', id: 'background-proof-group', tabs: [], activeTabId: '' } }] } }
    api.workspace = async () => structuredClone(workspace)
    api.workspaceAction = async action => {
      const group = workspace.layout.windows[0].root
      if (action.kind === 'open' || action.kind === 'activate') {
        if (!group.tabs.includes(action.tabId)) group.tabs.push(action.tabId)
        group.activeTabId = action.tabId
      } else if (action.kind === 'close') {
        group.tabs = group.tabs.filter(id => id !== action.tabId)
        if (group.activeTabId === action.tabId) group.activeTabId = group.tabs.at(-1) ?? ''
      }
      workspace.layout.revision++; workspace.sequence++
      return structuredClone(workspace)
    }
    for (const method of ['draft', 'saveDraft', 'attachments', 'draftSettings', 'saveDraftSettings']) {
      api[method] = (owner, ...args) => base[method](owner.replace(/:workspace:.*$/, ''), ...args)
    }
    api.jobs = async owner => {
      state.calls.push({ method: 'jobs', owner })
      if (state.pollError) throw new Error(state.pollError)
      return held(`jobs:${owner}`, owner === 'sample-thread-1' ? structuredClone(state.jobs) : [])
    }
    api.readJob = async (owner, id) => {
      state.calls.push({ method: 'readJob', owner, id })
      if (owner !== 'sample-thread-1' || !state.jobs.some(job => job.id === id)) throw new Error('Foreign fixture job')
      return held(`read:${id}`, { output: `Retained output for ${id}`, truncated: id === 'server' })
    }
    api.stopJob = async (owner, id) => {
      state.calls.push({ method: 'stopJob', owner, id })
      if (owner !== 'sample-thread-1' || !state.jobs.some(job => job.id === id)) throw new Error('Foreign fixture job')
      await held(`stop:${id}`)
    }
    for (const method of ['send', 'startPalComputer', 'stopPalComputer', 'palComputerInput', 'approve']) {
      api[method] = async () => { state.actions.push(method); throw new Error(`Forbidden fixture action: ${method}`) }
    }
    window.__backgroundProof = {
      state,
      hold: key => { state.plans[key] = true },
      release: (key, value) => { const gate = state.gates[key]; if (!gate) throw new Error(`Missing gate ${key}`); delete state.gates[key]; gate.resolve(value) },
      reject: (key, message) => { const gate = state.gates[key]; if (!gate) throw new Error(`Missing gate ${key}`); delete state.gates[key]; gate.reject(new Error(message)) },
      tick: () => { for (const callback of [...state.intervals.values()]) callback() },
    }
  } })
})
const row = id => page.locator(`.jobs-panel .job[data-job-id="${id}"]`)
const proof = (method, ...args) => page.evaluate(({ method, args }) => window.__backgroundProof[method](...args), { method, args })
const waitGate = key => page.waitForFunction(key => Boolean(window.__backgroundProof.state.gates[key]), key)
const settle = () => page.evaluate(async () => {
  for (const animation of document.getAnimations()) if (animation.transitionProperty) animation.finish()
  await document.fonts.ready
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
})
async function capture(name) {
  await settle()
  receipt.frames[name] = await page.evaluate(() => {
    const selectors = ['.jobs-panel', '.job-heading', '.job-command', '.job-status', '.job-details', '.job-output', '.job [data-slot=collapsible-panel]']
    return { viewport: { width: innerWidth, height: innerHeight }, overflow: document.documentElement.scrollWidth > innerWidth,
      nodes: Object.fromEntries(selectors.map(selector => [selector, [...document.querySelectorAll(selector)].map(node => {
        const style = getComputedStyle(node)
        return { ...node.getBoundingClientRect().toJSON(), fontSize: style.fontSize, lineHeight: style.lineHeight, transition: style.transition, color: style.color, overflow: style.overflow }
      })])) }
  })
  assert.equal(receipt.frames[name].overflow, false, name)
  await page.screenshot({ path: join(artifacts, `background-processes-${name}-20261006.png`) })
}
try {
  await page.goto(origin)
  await page.locator('.sidebar-recent-list').getByRole('button', { name: 'Refine navigation', exact: true }).click()
  await expect(page.locator('.conversation-tab[data-active="true"]')).toContainText('Refine navigation')
  const draft = page.getByRole('textbox', { name: 'Message Namzu', exact: true })
  await draft.fill('Retain this draft while inspecting process output.')
  if (await page.locator('.jobs-panel').getAttribute('data-open') !== 'true') await page.getByRole('button', { name: 'Background work', exact: true }).first().click()
  await expect(page.locator('.jobs-panel')).toHaveAttribute('data-open', 'true')
  await settle()
  await expect(row('server')).toHaveAttribute('data-job-status', 'running')
  await expect(row('build').locator('.job-status')).toHaveText('Done')
  await expect(row('lint').locator('.job-status')).toHaveText('Failed')
  await expect(row('unknown-exit').locator('.job-status')).toHaveText('Finished')
  await expect(page.locator('.background-processes-heading kbd')).toHaveText('2')
  await row('server').hover()
  await expect(row('server').getByRole('button', { name: /^Stop / })).toHaveCSS('opacity', '1')
  receipt.checks.push('compact command rows; running count; truthful success/failure/unknown-exit badges; hover stop')
  await capture('wide-dark')
  await proof('hold', 'read:server')
  await proof('hold', 'read:watcher')
  await row('server').getByRole('button', { name: /^Output for / }).click()
  await waitGate('read:server')
  await row('watcher').getByRole('button', { name: /^Output for / }).click()
  await waitGate('read:watcher')
  await expect(row('server').getByRole('button', { name: 'Reading…', exact: true })).toBeDisabled()
  await proof('release', 'read:watcher', { output: 'Watcher-only output', truncated: false })
  await expect(row('watcher').locator('.job-output')).toHaveText('Watcher-only output')
  await proof('release', 'read:server', { output: 'Server-only output', truncated: true })
  await expect(row('server').locator('.job-output')).toHaveText('Server-only output')
  await expect(row('server')).toContainText('Earlier output omitted.')
  await expect(row('watcher').locator('.job-output')).toHaveText('Watcher-only output')
  await proof('hold', 'read:watcher')
  await row('watcher').getByRole('button', { name: 'Refresh', exact: true }).click()
  await waitGate('read:watcher')
  await proof('release', 'read:watcher', { output: '', truncated: false })
  await expect(row('watcher')).toContainText('No output yet.')
  await expect(row('watcher').locator('.job-output')).toHaveCount(0)
  receipt.checks.push('overlapping A/B output stays within owned row; refresh replaces snapshot including empty output; truncated hint')
  await proof('tick')
  await expect(row('server').locator('.job-output')).toHaveText('Server-only output')
  receipt.checks.push('poll object replacement preserves open disclosure and retained output')
  await proof('hold', 'stop:server')
  await row('server').getByRole('button', { name: /^Stop / }).click()
  await waitGate('stop:server')
  await expect(row('server').getByRole('button', { name: /^Stop / })).toBeDisabled()
  await expect(row('server')).toHaveAttribute('data-job-status', 'running')
  await page.evaluate(() => {
    const job = window.__backgroundProof.state.jobs.find(job => job.id === 'server')
    job.recoveryRequired = true; job.stopError = 'Stopping could not be confirmed. Retry stop.'
  })
  await proof('reject', 'stop:server', 'Stopping could not be confirmed. Retry stop.')
  await expect(row('server').getByRole('alert')).toContainText('could not be confirmed')
  await proof('tick')
  await expect(row('server').getByRole('button', { name: /^Retry stop / })).toBeEnabled()
  await expect(row('server')).toHaveAttribute('data-job-status', 'running')
  receipt.checks.push('pending stop is disabled without optimistic termination; failed stop stays running with row-local retry')
  await proof('hold', 'jobs:sample-thread-1')
  await proof('tick')
  await waitGate('jobs:sample-thread-1')
  await proof('hold', 'stop:server')
  await row('server').getByRole('button', { name: /^Retry stop / }).click()
  await waitGate('stop:server')
  await page.evaluate(() => {
    const job = window.__backgroundProof.state.jobs.find(job => job.id === 'server')
    job.status = 'killed'; delete job.recoveryRequired; delete job.stopError
  })
  await proof('release', 'stop:server')
  await expect(row('server').getByRole('button', { name: /^Retry stop / })).toBeDisabled()
  await proof('release', 'jobs:sample-thread-1')
  await expect(row('server')).toHaveAttribute('data-job-status', 'killed')
  await expect(row('server').locator('.job-status')).toHaveText('Stopped')
  await expect(row('server').locator('.job-output')).toHaveText('Server-only output')
  await expect(row('server').getByRole('button', { name: /^(Stop|Retry stop) / })).toHaveCount(0)
  receipt.checks.push('stop refresh waits for older poll then reads fresh terminal truth; output survives terminal reorder')
  await page.waitForFunction(() => {
    const panel = document.querySelector('.job[data-job-id="server"] [data-slot="collapsible-panel"]')
    return panel && panel.hasAttribute('data-open') && !panel.hidden &&
      !panel.hasAttribute('data-starting-style') && !panel.hasAttribute('data-ending-style') &&
      panel.clientHeight >= panel.scrollHeight - 1 && panel.clientHeight > 0
  })
  receipt.checks.push('reordered open output settles at its full content height with no stale transition attributes')
  await capture('expanded-dark')
  await row('server').getByRole('button', { name: /^Output for / }).click()
  await expect(row('server').locator('[data-slot="collapsible-panel"]')).toHaveAttribute('hidden', '')
  receipt.checks.push('retained panel closes with hidden semantics and no accessible terminal output')
  await proof('hold', 'read:watcher')
  await row('watcher').getByRole('button', { name: 'Refresh', exact: true }).click()
  await waitGate('read:watcher')
  await proof('hold', 'stop:watcher')
  await row('watcher').getByRole('button', { name: /^Stop / }).click()
  await waitGate('stop:watcher')
  await page.locator('.sidebar-recent-list').getByRole('button', { name: 'Improve the quick start', exact: true }).click()
  await expect(page.locator('.conversation-tab[data-active="true"]')).toContainText('Improve the quick start')
  await proof('release', 'read:watcher', { output: 'STALE_FOREIGN_OUTPUT', truncated: false })
  await proof('reject', 'stop:watcher', 'STALE_FOREIGN_STOP_ERROR')
  await expect(page.getByText('STALE_FOREIGN_OUTPUT', { exact: true })).toHaveCount(0)
  await expect(page.getByText('STALE_FOREIGN_STOP_ERROR', { exact: true })).toHaveCount(0)
  receipt.checks.push('navigation retires delayed output and stop failure; no foreign conversation banner')
  await page.locator('.sidebar-recent-list').getByRole('button', { name: 'Refine navigation', exact: true }).click()
  await expect(page.locator('.conversation-tab[data-active="true"]')).toContainText('Refine navigation')
  if (await page.locator('.jobs-panel').getAttribute('data-open') !== 'true') await page.getByRole('button', { name: 'Background work', exact: true }).first().click()
  await expect(page.locator('.jobs-panel')).toHaveAttribute('data-open', 'true')
  await settle()
  await expect(row('server')).toBeVisible()
  await expect(row('server').locator('.job-output')).toHaveCount(0)
  await expect(draft).toHaveValue('Retain this draft while inspecting process output.')
  await page.evaluate(() => { window.__backgroundProof.state.pollError = 'Process list is temporarily unavailable.' })
  await proof('tick')
  await expect(page.locator('.background-processes').getByRole('alert')).toHaveText('Process list is temporarily unavailable.')
  await expect(page.locator('.background-processes-heading kbd')).toHaveCount(0)
  await page.evaluate(() => { window.__backgroundProof.state.pollError = '' })
  await proof('tick')
  await expect(row('watcher')).toBeVisible()
  receipt.checks.push('new navigation begins without previous outputs; retained draft; list failure never claims zero running')
  await page.setViewportSize({ width: 600, height: 540 })
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.evaluate(() => { document.documentElement.dataset.appearance = 'light'; document.documentElement.classList.remove('dark') })
  await row('watcher').getByRole('button', { name: /^Output for / }).click()
  await expect(row('watcher').locator('.job-output')).toHaveText('Retained output for watcher')
  await expect(row('watcher').locator('[data-slot="collapsible-panel"]')).toHaveCSS('transition-duration', '0s')
  await capture('narrow-light-reduced')
  await page.getByRole('button', { name: 'Close activity', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Background work', exact: true }).first()).toBeFocused()
  await expect(draft).toHaveValue('Retain this draft while inspecting process output.')
  receipt.checks.push('narrow/short light theme reflows long commands; reduced motion settles disclosure; panel close restores opener/draft')
  const state = await page.evaluate(() => ({ calls: window.__backgroundProof.state.calls, actions: window.__backgroundProof.state.actions }))
  assert.deepEqual(state.actions, [])
  assert.deepEqual(faults, [])
  assert.ok(state.calls.filter(call => ['readJob', 'stopJob'].includes(call.method)).every(call => call.owner === 'sample-thread-1'))
  receipt.fixtureCalls = state.calls.length
  receipt.passed = true
  await writeFile(join(artifacts, 'background-processes-browser-proof-20261006.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(JSON.stringify({ passed: true, checks: receipt.checks.length, fixtureCalls: receipt.fixtureCalls, modelRequests: 0, nativeActions: 0 }))
} catch (error) { console.error(JSON.stringify({ faults, body: (await page.locator('body').innerText()).slice(0, 2500) })); throw error } finally { await browser.close() }
