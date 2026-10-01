/** Owned localhost preview only: deterministic Recents order, no native/model operations. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? '.')
const baseline = process.argv.includes('--baseline')
const out = join(repo, 'research/runtime-desktop-20260930/artifacts')
const { chromium, expect } = createRequire(join(repo, 'packages/desktop/package.json'))('@playwright/test')
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1609, height: 973 }, colorScheme: 'dark' })
const page = await context.newPage(), steps = [], errors = []
const origin = 'http://127.0.0.1:5173'
page.on('pageerror', error => errors.push(error.message))
await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
await mkdir(out, { recursive: true })
await page.addInitScript(() => {
  let api
  const qa = window.__recentsOrderQa = { reads: [], reverse: false, newer: false, mutations: 0, listeners: new Set(), projects: [] }
  Object.defineProperty(window, 'namzu', { configurable: true, get: () => api, set(value) {
    api = value
    const list = api.conversations.bind(api), projects = api.projects.bind(api), subscribe = api.onEvent.bind(api)
    api.projects = async () => { const value = await projects(); qa.projects = value; return value }
    api.conversations = async id => {
      let rows = await list(id)
      if (qa.newer) rows = rows.map(row => row.id === 'sample-thread-6' ? { ...row, updatedAt: '2026-10-01T10:00:00.000Z' } : row)
      if (qa.reverse) rows.reverse()
      qa.reads.push(id)
      return rows
    }
    api.onEvent = listener => { qa.listeners.add(listener); const remove = subscribe(listener); return () => { qa.listeners.delete(listener); remove() } }
    for (const name of ['send', 'cancel', 'approve', 'stopJob', 'setPluginEnabled', 'openProject', 'newConversation']) api[name] = async () => { qa.mutations++; throw new Error('Native/model mutation forbidden in this proof.') }
    qa.refresh = projectId => { for (const listener of qa.listeners) listener({ kind: 'connection', project: { ...qa.projects.find(project => project.id === projectId) }, revision: ++qa.revision }) }
    qa.revision = 0
  } })
})
const recents = () => page.locator('.sidebar-recent-list')
async function order(label) {
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  const value = await recents().locator('[data-session-id]').evaluateAll(nodes => nodes.map(node => node.dataset.sessionId))
  steps.push({ label, ids: value })
  return value
}
async function open(id) {
  const row = recents().locator(`[data-session-id="${id}"] button`)
  await row.click()
  await expect(row).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('#namzu-sidebar [data-session-id] button[aria-current="page"]')).toHaveCount(1)
  return await order(`open ${id}`)
}
async function refresh(projectId = 'sample-workspace') {
  const count = await page.evaluate(() => window.__recentsOrderQa.reads.length)
  await page.evaluate(projectId => window.__recentsOrderQa.refresh(projectId), projectId)
  await page.waitForFunction(count => window.__recentsOrderQa.reads.length > count, count)
}
try {
  await page.goto(`${origin}/preview`)
  await expect(page.getByRole('status', { name: 'Design preview', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Search conversations', exact: true }).click()
  await expect(recents().locator('[data-session-id]')).toHaveCount(6)
  await expect(page.getByRole('dialog', { name: 'Search chats and actions', exact: true }).getByRole('option', { name: /Keep notes readable/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Search chats and actions', exact: true })).toHaveCount(0)
  const initial = await order('all indexes loaded')
  for (const id of ['sample-thread-4', 'sample-thread-1', 'sample-thread-6', 'sample-thread-5', 'sample-thread-2']) {
    const ids = await open(id)
    if (!baseline) assert.deepEqual(ids, initial, `Recents must not move when opening ${id}`)
  }
  if (!baseline) {
    await page.evaluate(() => { window.__recentsOrderQa.reverse = true })
    await refresh('sample-app')
    assert.deepEqual(await order('reversed API rows, equal timestamps'), initial)
    await open('sample-thread-6')
    assert.deepEqual(await order('return to workspace'), initial)
    await page.mouse.move(900, 90)
    await page.evaluate(async () => {
      await document.fonts.ready
      await Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished))
    })
    await page.screenshot({ path: join(out, 'recents-order-wide-dark.png') })
    await page.evaluate(() => { window.__recentsOrderQa.newer = true })
    await refresh()
    const changed = await order('real newer metadata may reorder')
    assert.equal(changed[0], 'sample-thread-6')
    assert.deepEqual(changed.slice(1), initial.filter(id => id !== 'sample-thread-6'))
  }
  const counts = await page.evaluate(() => ({ reads: window.__recentsOrderQa.reads.length, mutations: window.__recentsOrderQa.mutations }))
  assert.equal(counts.mutations, 0); assert.deepEqual(errors, [])
  const result = { passed: !baseline, baseline, reproduced: baseline && steps.some(step => JSON.stringify(step.ids) !== JSON.stringify(initial)), scope: 'Owned localhost sample preview only. Connection refresh, reversed API rows and newer saved metadata are synthetic read fixtures; no model/native operation.', steps, counts, errors }
  if (!baseline) result.beforeFix = JSON.parse(await readFile(join(out, 'recents-order-baseline.json'), 'utf8'))
  await writeFile(join(out, baseline ? 'recents-order-baseline.json' : 'recents-order-receipt.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} finally { await context.close(); await browser.close() }
