/** Real React StrictMode UI, isolated sample API; no model/native/guest actions. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
const repo = resolve(process.argv[2] ?? '.')
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { createServer } = await import(require.resolve('vite'))
const server = await createServer({ root: join(repo, 'packages/desktop'), server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' })
await server.listen()
const origin = `http://127.0.0.1:${server.httpServer.address().port}/preview`
const { chromium, expect } = require('@playwright/test')
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] })
const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, colorScheme: 'dark' })
const page = await context.newPage()
const faults = []
page.on('pageerror', error => faults.push(error.message))
page.setDefaultTimeout(12000)
await context.route('**/*', route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort())
const artifacts = join(repo, 'research/runtime-desktop-20260930/artifacts')
await mkdir(artifacts, { recursive: true })
const receipt = { passed: false, realRenderer: true, reactStrictMode: true, sampleOnly: true, nativeActions: 0, modelRequests: 0, computerActions: 0, checks: [] }
try {
 await page.addInitScript(() => {
  let api
  const listeners = new Set()
  const removedSessions = new Set(), removedPals = new Set()
  const workspace = { windowId: 'remove-window', sequence: 0, homeGroupId: 'remove-group', layout: { version: 1, revision: 0, windows: [{ id: 'remove-window', focusedGroupId: 'remove-group', root: { kind: 'group', id: 'remove-group', tabs: [], activeTabId: '' } }] } }
  const proof = { calls: [], mode: 'error', release: undefined, listings: 0, holdHistory: undefined, historyRelease: undefined }
  const emit = event => { for (const listener of listeners) listener(event) }
  const retire = ids => {
   const group = workspace.layout.windows[0].root
   group.tabs = group.tabs.filter(id => !ids.includes(id))
   if (ids.includes(group.activeTabId)) group.activeTabId = group.tabs.at(-1) ?? ''
   workspace.sequence++; workspace.layout.revision++
   emit({ kind: 'workspace', view: structuredClone(workspace) })
  }
  Object.defineProperty(window, 'namzu', { configurable: true, get: () => api, set(value) {
   api = value
   const base = { ...value }
   api.workspace = async () => structuredClone(workspace)
   api.workspaceAction = async action => {
    const group = workspace.layout.windows[0].root
    if (action.kind === 'open' || action.kind === 'activate') { if (!group.tabs.includes(action.tabId)) group.tabs.push(action.tabId); group.activeTabId = action.tabId }
    else if (action.kind === 'close') { group.tabs = group.tabs.filter(id => id !== action.tabId); if (group.activeTabId === action.tabId) group.activeTabId = group.tabs.at(-1) ?? '' }
    workspace.sequence++; workspace.layout.revision++
    return structuredClone(workspace)
   }
   api.onEvent = listener => { listeners.add(listener); return () => listeners.delete(listener) }
   for (const name of ['draft', 'saveDraft', 'attachments', 'draftSettings', 'saveDraftSettings']) api[name] = (owner, ...args) => base[name](owner.replace(/:workspace:.*$/, ''), ...args)
   api.projects = async () => (await base.projects()).filter(item => !removedPals.has(item.palId))
   api.pals = async () => (await base.pals()).filter(item => !removedPals.has(item.id))
   api.conversations = async id => { proof.listings++; return (await base.conversations(id)).filter(item => !removedSessions.has(item.id)) }
   api.openConversation = async (projectId, id) => {
    const history = await base.openConversation(projectId, id)
    if (proof.holdHistory === id) await new Promise(resolve => { proof.historyRelease = resolve })
    return history
   }
   api.send = async () => { throw Error('Provider submission forbidden in browser proof') }
   api.startPalComputer = api.stopPalComputer = async () => { throw Error('Guest action forbidden in browser proof') }
   api.removeConversation = async id => {
    proof.calls.push({ kind: 'conversation', id })
    if (proof.mode === 'error') throw Error('Fixture archive could not be confirmed')
    if (proof.mode === 'held') await new Promise(resolve => { proof.release = resolve })
    let owner
    for (const value of await base.projects()) if ((await base.conversations(value.id)).some(item => item.id === id)) owner = value
    if (!owner) throw Error('Unknown fixture session')
    removedSessions.add(id)
    emit({ kind: 'conversation-removed', sessionId: id, projectId: owner.id, archived: true })
    retire([id])
    return { sessionId: id, removed: true, archived: true }
   }
   api.deletePal = async (id, expectedRevision) => {
    proof.calls.push({ kind: 'pal', id, expectedRevision })
    if (proof.mode === 'error') throw Error('Fixture computer cleanup failed')
    const value = (await base.pals()).find(item => item.id === id)
    if (!value || value.revision !== expectedRevision) throw Error('Fixture revision changed')
    const project = (await base.projects()).find(item => item.palId === id)
    const sessions = await base.conversations(project.id)
    removedPals.add(id); for (const session of sessions) removedSessions.add(session.id)
    emit({ kind: 'pal-deleted', palId: id, projectIds: [project.id], sessionIds: sessions.map(item => item.id) })
    retire(sessions.map(item => item.id))
    return { id, deleted: true }
   }
   window.__removeProof = proof
  } })
 })
 await page.goto(origin)
 await expect(page.getByRole('status', { name: 'Design preview', exact: true })).toBeVisible()
 const recent = page.locator('.sidebar-recent-list')
 const target = recent.locator('[data-session-id="sample-thread-2"]')
 await target.hover()
 const more = target.getByRole('button', { name: 'Actions for Polish empty states', exact: true })
 await more.click()
 await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click()
 let dialog = page.getByRole('alertdialog', { name: 'Delete conversation?', exact: true })
 await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
 await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
 await expect(dialog).toHaveCount(0)
 assert.equal(await page.evaluate(() => window.__removeProof.calls.length), 0)
 await expect(more).toBeFocused()
 receipt.checks.push('inactive Recents menu is independent of row selection; confirmation cancel sends no write and returns focus')
 await more.click(); await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click()
 await dialog.getByRole('button', { name: 'Delete conversation', exact: true }).click()
 await expect(dialog.getByRole('alert')).toHaveText('Fixture archive could not be confirmed')
 await expect(target).toBeVisible()
 await page.evaluate(() => { window.__removeProof.mode = 'held' })
 await dialog.getByRole('button', { name: 'Delete conversation', exact: true }).click()
 await expect(dialog.getByRole('button', { name: 'Removing…', exact: true })).toBeDisabled()
 await page.keyboard.press('Escape')
 await expect(dialog).toBeVisible()
 assert.equal(await page.evaluate(() => window.__removeProof.calls.length), 2)
 await page.evaluate(() => window.__removeProof.release())
 await expect(dialog).toHaveCount(0)
 await expect(page.locator('[data-thread-item][data-session-id="sample-thread-2"]')).toHaveCount(0)
 receipt.checks.push('failed archive retains row and error; retry runs once, pending cannot dismiss, successful ACK retires both project and Recents rows')
 await page.locator('.sidebar-project-navigation').getByRole('button', { name: 'Refine navigation', exact: true }).click()
 const tab = page.locator('.conversation-tab[data-tab-id="sample-thread-1"]')
 await expect(tab).toBeVisible()
 await tab.getByRole('button', { name: 'Actions for Refine navigation', exact: true }).click()
 await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click()
 await page.evaluate(() => { window.__removeProof.mode = 'success' })
 await dialog.getByRole('button', { name: 'Delete conversation', exact: true }).click()
 await expect(dialog).toHaveCount(0); await expect(tab).toHaveCount(0)
 await expect(page.locator('[data-thread-item][data-session-id="sample-thread-1"]')).toHaveCount(0)
 receipt.checks.push('ordinary tab removal closes active view; deleting an inactive recent required no openConversation')
 await page.evaluate(() => { window.__removeProof.holdHistory = 'sample-thread-3' })
 await page.locator('.sidebar-project-navigation').getByRole('button', { name: 'Review message settings', exact: true }).click()
 await expect(page.locator('.conversation-tab[data-tab-id="sample-thread-3"]')).toBeVisible()
 const pendingRecent = page.locator('.sidebar-recent-list [data-session-id="sample-thread-3"]')
 await pendingRecent.hover(); await pendingRecent.getByRole('button', { name: 'Actions for Review message settings', exact: true }).click()
 await page.getByRole('menuitem', { name: 'Delete conversation', exact: true }).click()
 await dialog.getByRole('button', { name: 'Delete conversation', exact: true }).click()
 await expect(dialog).toHaveCount(0)
 await page.evaluate(() => window.__removeProof.historyRelease())
 await expect(page.locator('.conversation-tab[data-tab-id="sample-thread-3"]')).toHaveCount(0)
 await expect(page.locator('[data-thread-item][data-session-id="sample-thread-3"]')).toHaveCount(0)
 await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
 await expect(page.locator('.workspace-conversation-header')).not.toContainText('Review message settings')
 receipt.checks.push('late cold-history completion cannot reintroduce a removed conversation')

 await page.getByRole('button', { name: 'Create your first Pal', exact: true }).click()
 await page.locator('.pal-welcome').getByRole('button', { name: 'Customize your Pal', exact: true }).click()
 let customize = page.getByRole('dialog', { name: 'Customize your Pal', exact: true })
 await customize.getByRole('textbox', { name: 'Pal name', exact: true }).fill('Removal fixture')
 await customize.getByRole('button', { name: 'Save', exact: true }).click()
 await expect(customize).toHaveCount(0)
 const card = page.locator('[aria-label="Pal context"]')
 await expect(card).toBeVisible()
 await card.getByRole('button', { name: 'Customize Removal fixture', exact: true }).click()
 await expect(customize).toBeVisible()
 await customize.getByRole('button', { name: 'Delete Removal fixture', exact: true }).click()
 dialog = page.getByRole('alertdialog', { name: 'Delete Removal fixture?', exact: true })
 await expect(dialog).toContainText('saved conversations and files will stay')
 await page.evaluate(() => { window.__removeProof.mode = 'error' })
 await dialog.getByRole('button', { name: 'Delete Pal', exact: true }).click()
 await expect(dialog.getByRole('alert')).toHaveText('Fixture computer cleanup failed')
 await expect(card).toBeVisible()
 await page.evaluate(() => { window.__removeProof.mode = 'success' })
 await dialog.getByRole('button', { name: 'Delete Pal', exact: true }).click()
 await expect(dialog).toHaveCount(0); await expect(customize).toHaveCount(0); await expect(card).toHaveCount(0)
 await expect(page.getByRole('button', { name: 'Removal fixture', exact: true })).toHaveCount(0)
 receipt.checks.push('Pal edit exposes deletion; retained-data disclosure, cleanup failure retention and successful all-view retirement exercised')
 await expect(page.getByRole('button', { name: 'Create your first Pal', exact: true })).toBeVisible()
 assert.deepEqual(faults, [])
 receipt.calls = await page.evaluate(() => window.__removeProof.calls)
 receipt.screenshot = 'removal-empty-state-browser-20261006.png'
 await page.screenshot({ path: join(artifacts, receipt.screenshot) })
 receipt.passed = true
} catch (error) { receipt.error = { name: error.name, message: error.message }; receipt.debug = await page.evaluate(() => ({calls:window.__removeProof?.calls,mode:window.__removeProof?.mode,rows:[...document.querySelectorAll('[data-thread-item]')].map(n=>({id:n.dataset.sessionId,visible:!!n.getBoundingClientRect().height,parent:n.parentElement.getAttribute('aria-label')})),text:document.body.innerText})); await page.screenshot({path:join(artifacts,'removal-failure-browser-20261006.png')}); process.exitCode = 1 }
finally { receipt.pageErrors = faults; await writeFile(join(artifacts, 'removal-dialog-browser-proof-20261006.json'), JSON.stringify(receipt, null, 2)+'\n'); await browser.close(); await server.close() }
console.log(JSON.stringify({ passed: receipt.passed, checks: receipt.checks.length, error: receipt.error }))
