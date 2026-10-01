/** Bounded sidebar navigation proof: owned preview, controlled reads, no native/model mutations. */
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
const captures = [], faults = [], steps = []
const first = 'sample-thread-1', second = 'sample-thread-2', third = 'sample-thread-3'
const sidebar = () => page.getByRole('complementary', { name: 'Projects and conversations', exact: true })
const row = (collection, id) => sidebar().locator(`${collection === 'recent' ? '.sidebar-recent-list' : '.sidebar-project-navigation'} [data-session-id="${id}"]`)
const toolbar = () => page.locator('.workspace .topbar')
const command = () => page.getByRole('dialog', { name: 'Search chats and actions', exact: true })
page.setDefaultTimeout(20000)
page.on('pageerror', error => faults.push(error.message))
await context.route('**/*', route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort())
await mkdir(artifacts, { recursive: true })
await page.addInitScript(() => {
  let api
  const qa = window.__sidebarSelectionQa = { listeners: new Set(), reads: [], opens: [], pending: {}, plans: {}, completed: [], revisions: {}, events: [], projects: [], failProviders: null, forbidden: { send: 0, cancel: 0, approve: 0, stopJob: 0, pluginChanges: 0, openProject: 0, newConversation: 0 } }
  Object.defineProperty(window, 'namzu', {
    configurable: true, get: () => api,
    set(value) {
      api = value
      const subscribe = api.onEvent.bind(api), projects = api.projects.bind(api), catalogue = api.conversations.bind(api), open = api.openConversation.bind(api), providers = api.providers.bind(api)
      api.onEvent = listener => { qa.listeners.add(listener); const remove = subscribe(listener); return () => { qa.listeners.delete(listener); remove() } }
      api.projects = async () => { const value = await projects(); qa.projects = structuredClone(value); return value }
      api.conversations = async projectId => { qa.reads.push(projectId); return await catalogue(projectId) }
      api.openConversation = async (projectId, sessionId) => {
        const token = qa.plans[sessionId]
        delete qa.plans[sessionId]
        qa.opens.push({ projectId, sessionId, token: token ?? null })
        const snapshot = await open(projectId, sessionId)
        if (!token) return snapshot
        try {
          return await new Promise((resolve, reject) => { qa.pending[token] = { resolve: () => resolve(structuredClone(snapshot)), reject: () => reject(new Error('Explicit synthetic stale open failure')) } })
        } finally { qa.completed.push(token); delete qa.pending[token] }
      }
      api.providers = async (projectId, sessionId) => {
        if (sessionId && qa.failProviders === sessionId) {
          qa.failProviders = null
          throw new Error('Explicit synthetic route failure after history')
        }
        return await providers(projectId, sessionId)
      }
      for (const [method, counter] of [['send', 'send'], ['cancel', 'cancel'], ['approve', 'approve'], ['stopJob', 'stopJob'], ['setPluginEnabled', 'pluginChanges'], ['openProject', 'openProject'], ['newConversation', 'newConversation']]) api[method] = async () => { qa.forbidden[counter]++; throw new Error(`This proof must not invoke ${method}.`) }
      qa.emit = event => {
        const id = event.sessionId ?? event.project?.id
        const revision = (qa.revisions[id] ?? 0) + 1
        qa.revisions[id] = revision
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
async function snapshot() {
  await settle()
  return await page.evaluate(() => {
    const root = document.querySelector('#namzu-sidebar')
    const active = [...root.querySelectorAll('[data-session-id] button[aria-current="page"]')].map(button => ({ id: button.closest('[data-session-id]').dataset.sessionId, collection: button.closest('.sidebar-recent-list') ? 'recent' : 'project' }))
    const folderHighlights = [...root.querySelectorAll('.sidebar-project-heading[data-selected]')].map(node => node.closest('[data-project-group]').dataset.projectGroup)
    const folderCurrent = [...root.querySelectorAll('.project-row[aria-current="page"]')].map(node => node.closest('[data-project-group]').dataset.projectGroup)
    return { active, folderHighlights, folderCurrent, groups: [...root.querySelectorAll('[data-project-group]')].map(node => ({ id: node.dataset.projectGroup, expanded: node.querySelector('.sidebar-project-toggle').getAttribute('aria-expanded') })), projectDots: root.querySelectorAll('.project-row .connection-dot').length, backgroundOpen: document.querySelector('.jobs-panel')?.getAttribute('data-open'), header: [...document.querySelectorAll('.workspace .topbar button')].filter(node => node.getClientRects().length).map(node => node.getAttribute('aria-label')), spinners: [...root.querySelectorAll('.thread-running-indicator')].map(node => ({ id: node.closest('[data-session-id]').dataset.sessionId, collection: node.closest('.sidebar-recent-list') ? 'recent' : 'project', animation: getComputedStyle(node).animationName })), api: { reads: [...window.__sidebarSelectionQa.reads], opens: [...window.__sidebarSelectionQa.opens], completed: [...window.__sidebarSelectionQa.completed], events: [...window.__sidebarSelectionQa.events], forbidden: { ...window.__sidebarSelectionQa.forbidden } } }
  })
}
async function accepted(id, collection, label) {
  const selected = sidebar().locator('[data-session-id] button[aria-current="page"]')
  await expect(selected).toHaveCount(id ? 1 : 0)
  if (id) {
    await expect(row(collection, id).getByRole('button')).toHaveAttribute('aria-current', 'page')
    await expect(sidebar().locator('.sidebar-project-heading[data-selected]')).toHaveCount(0)
    await expect(sidebar().locator('.project-row[aria-current="page"]')).toHaveCount(0)
  }
  const value = await snapshot()
  assert.deepEqual(value.active, id ? [{ id, collection }] : [])
  assert.equal(value.projectDots, 0)
  steps.push({ label, ...value })
  return value
}
async function openRow(collection, id) {
  await row(collection, id).getByRole('button').click()
  await accepted(id, collection, `accepted ${collection} ${id}`)
}
async function controls(present) {
  for (const name of ['Background work', 'Show changes']) await expect(toolbar().getByRole('button', { name, exact: true })).toHaveCount(present ? 1 : 0)
}
async function hold(id, token, { failProviders = false } = {}) {
  await page.evaluate(({ id, token, failProviders }) => { window.__sidebarSelectionQa.plans[id] = token; if (failProviders) window.__sidebarSelectionQa.failProviders = id }, { id, token, failProviders })
}
async function waitPending(token) { await page.waitForFunction(token => Boolean(window.__sidebarSelectionQa.pending[token]), token) }
async function release(token) {
  await page.evaluate(token => window.__sidebarSelectionQa.pending[token].resolve(), token)
  await page.waitForFunction(token => window.__sidebarSelectionQa.completed.includes(token), token)
  await settle()
}
async function capture(name) {
  const state = await snapshot()
  const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dark: document.documentElement.classList.contains('dark'), reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, overflow: document.documentElement.scrollWidth > innerWidth }))
  assert.equal(dimensions.overflow, false)
  const value = { name, ...dimensions, ...state }
  await writeFile(join(artifacts, `sidebar-selection-${name}.json`), JSON.stringify(value, null, 2) + '\n')
  await page.screenshot({ path: join(artifacts, `sidebar-selection-${name}.png`) })
  captures.push(value)
}

try {
  await page.goto(new URL('preview', origin).href)
  await expect(page.getByRole('status', { name: 'Design preview', exact: true })).toBeVisible()
  await expect(row('project', first)).toHaveCount(1)
  await expect(sidebar().getByRole('button', { name: 'Collapse Sample app conversations', exact: true })).toHaveAttribute('aria-expanded', 'true')
  for (const name of ['Sample docs', 'Sample workspace']) await expect(sidebar().getByRole('button', { name: `Expand ${name} conversations`, exact: true })).toHaveAttribute('aria-expanded', 'false')
  await accepted(null, null, 'initial blank project')
  await controls(false)
  await capture('wide-dark-blank-project')

  await sidebar().getByRole('button', { name: 'Collapse Sample app conversations', exact: true }).click()
  await sidebar().getByRole('button', { name: 'Search conversations', exact: true }).click()
  await expect(command()).toBeVisible()
  await expect(command().getByRole('option', { name: /Keep notes readable/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(command()).toHaveCount(0)
  await expect(sidebar().getByRole('button', { name: 'Expand Sample app conversations', exact: true })).toHaveAttribute('aria-expanded', 'false')
  const before = await page.evaluate(() => window.__sidebarSelectionQa.reads.filter(id => id === 'sample-app').length)
  await page.evaluate(() => window.__sidebarSelectionQa.emit({ kind: 'connection', project: window.__sidebarSelectionQa.projects.find(project => project.id === 'sample-app') }))
  await page.waitForFunction(before => window.__sidebarSelectionQa.reads.filter(id => id === 'sample-app').length > before, before)
  await expect(sidebar().getByRole('button', { name: 'Expand Sample app conversations', exact: true })).toHaveAttribute('aria-expanded', 'false')
  for (const name of ['Sample docs', 'Sample workspace']) await expect(sidebar().getByRole('button', { name: `Expand ${name} conversations`, exact: true })).toHaveAttribute('aria-expanded', 'false')
  await openRow('recent', first)
  await expect(sidebar().getByRole('button', { name: 'Expand Sample app conversations', exact: true })).toHaveAttribute('aria-expanded', 'false')
  await sidebar().getByRole('button', { name: 'Expand Sample app conversations', exact: true }).click()
  await accepted(first, 'recent', 'same session visible in both collections; only Recents selected')
  await controls(true)
  await page.evaluate(id => window.__sidebarSelectionQa.emit({ kind: 'state', sessionId: id, running: true, queued: [] }), first)
  await expect(sidebar().locator(`[data-session-id="${first}"] .thread-running-indicator`)).toHaveCount(2)
  await capture('wide-dark-recent-selected-shared-running')
  await openRow('project', first)

  await hold(second, 'pending-failed', { failProviders: true })
  await row('recent', second).getByRole('button').click()
  await waitPending('pending-failed')
  await accepted(first, 'project', 'pending open leaves accepted selection')
  await release('pending-failed')
  await expect(page.locator('.connection-error')).toContainText('Explicit synthetic route failure after history')
  await accepted(first, 'project', 'failed route leaves accepted selection')
  await hold(second, 'stale-open')
  await row('recent', second).getByRole('button').click()
  await waitPending('stale-open')
  await accepted(first, 'project', 'superseded open still pending')
  await openRow('project', third)
  await release('stale-open')
  await accepted(third, 'project', 'stale completion cannot change newer accepted selection')
  await expect(page.locator('.connection-error')).toHaveCount(0)
  await controls(true)
  await toolbar().getByRole('button', { name: 'Background work', exact: true }).click()
  await expect(page.locator('.jobs-panel')).toHaveAttribute('data-open', 'true')
  await sidebar().getByRole('button', { name: 'Open Sample docs', exact: true }).click()
  await accepted(null, null, 'blank folder navigation clears conversation selection')
  await controls(false)
  await expect(page.locator('.jobs-panel')).toHaveAttribute('data-open', 'false')
  await expect(sidebar().locator('.sidebar-project-heading[data-selected]')).toHaveCount(1)
  await sidebar().getByRole('button', { name: 'Open Sample app', exact: true }).click()
  await openRow('project', first)
  await controls(true)
  await expect(sidebar().locator(`[data-session-id="${first}"] .thread-running-indicator`)).toHaveCount(2)
  await sidebar().getByRole('button', { name: 'Collapse Sample docs conversations', exact: true }).click()
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: 'Profile', exact: true }).click()
  await page.getByRole('menuitemradio', { name: 'Light', exact: true }).click()
  await page.setViewportSize({ width: 600, height: 540 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click()
  await expect(sidebar()).toHaveClass(/\bopen\b/)
  await accepted(first, 'project', 'narrow reduced-motion selected Project copy')
  await capture('narrow-light-project-selected-reduced')
  await page.evaluate(id => window.__sidebarSelectionQa.emit({ kind: 'state', sessionId: id, running: false, queued: [] }), first)
  const counts = await page.evaluate(() => ({ reads: window.__sidebarSelectionQa.reads, opens: window.__sidebarSelectionQa.opens, completed: window.__sidebarSelectionQa.completed, events: window.__sidebarSelectionQa.events, forbidden: window.__sidebarSelectionQa.forbidden }))
  assert.deepEqual(counts.forbidden, { send: 0, cancel: 0, approve: 0, stopJob: 0, pluginChanges: 0, openProject: 0, newConversation: 0 })
  assert.deepEqual(faults, [])
  const receipt = { passed: true, scope: 'One owned localhost development-preview context with existing sample records. Pending history reads, one post-history provider failure, a connection refresh and running events are controlled synthetic fixtures. No real model/provider request, native session/folder operation, process, approval or plugin/scheduler mutation is claimed.', checks: ['Project connection dots absent', 'Exactly one accepted conversation copy selected and no selected folder', 'Initial current project open, unknown projects closed', 'Explicit collapse retained through Search, catalogue refresh and Recents navigation', 'Blank project toolbar omits Background work/Show changes; actual conversation restores both', 'Background work closes when navigating to a blank folder', 'Pending/failed/stale reads preserve accepted selection until a newer successful open', 'Duplicate conversation copies still share turn activity'], steps, counts, captures, pageErrors: faults }
  await writeFile(join(artifacts, 'sidebar-selection-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, captures: captures.length, receipt: join(artifacts, 'sidebar-selection-receipt.json') }))
} catch (error) {
  await writeFile(join(artifacts, 'sidebar-selection-receipt.json'), JSON.stringify({ passed: false, scope: 'Isolated localhost preview with controlled synthetic reads only.', error: String(error), steps, captures, pageErrors: faults }, null, 2) + '\n')
  throw error
} finally { await context.close(); await browser.close() }
