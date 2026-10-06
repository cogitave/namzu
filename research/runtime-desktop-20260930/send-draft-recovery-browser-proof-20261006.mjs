/** Real React StrictMode App and sample API; deferred ACKs, no native/model/guest actions. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? '.')
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { createServer } = await import(require.resolve('vite'))
const server = await createServer({
 root: join(repo, 'packages/desktop'),
 server: { host: '127.0.0.1', port: 0, strictPort: false },
 logLevel: 'error',
})
await server.listen()
const origin = `http://127.0.0.1:${server.httpServer.address().port}/preview`
const { chromium, expect } = require('@playwright/test')
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] })
const artifacts = join(repo, 'research/runtime-desktop-20260930/artifacts')
await mkdir(artifacts, { recursive: true })
const receipt = {
 passed: false, realRenderer: true, reactStrictMode: true, sampleOnly: true,
 nativeActions: 0, modelRequests: 0, computerActions: 0,
 synchronization: 'Controlled admission/ACK promises and actual sample draft writes; no wall-clock races.',
 checks: [], pageErrors: [],
}

function installFixture() {
 let api
 const listeners = new Set()
 const revisions = new Map()
 const waiters = []
 const admissions = []
 const workspace = {
  windowId: 'draft-window', sequence: 0, homeGroupId: 'draft-group',
  layout: { version: 1, revision: 0, windows: [{
   id: 'draft-window', focusedGroupId: 'draft-group',
   root: { kind: 'group', id: 'draft-group', tabs: [], activeTabId: '' },
  }] },
 }
 const owner = id => id.replace(/:workspace:.*$/, '')
 const emit = event => { for (const listener of listeners) listener(event) }
 Object.defineProperty(window, 'namzu', { configurable: true, get: () => api, set(value) {
  api = value
  const base = { ...value }
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
   workspace.sequence++; workspace.layout.revision++
   return structuredClone(workspace)
  }
  api.onEvent = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  for (const name of ['draft', 'attachments', 'draftSettings', 'saveDraftSettings'])
   api[name] = (id, ...args) => base[name](owner(id), ...args)
  api.saveDraft = async (id, text) => {
   id = owner(id)
   revisions.set(id, (revisions.get(id) ?? 0) + 1)
   await base.saveDraft(id, text)
  }
  api.openConversation = async (projectId, id) => {
   await base.openConversation(projectId, id) // Preserve real sample project ownership validation.
   return { messages: [], partial: false }
  }
  api.send = async (id, prompt) => {
   await base.draft(id) // Reject any unknown fixture owner.
   const admission = { id, prompt, revision: revisions.get(id) ?? 0, acknowledged: false, restored: false }
   const ack = new Promise(resolve => { admission.release = resolve })
   if (await base.draft(id) === prompt) await base.saveDraft(id, '')
   admissions.push(admission)
   emit({ kind: 'state', sessionId: id, running: true, queued: [], queuedItems: [] })
   for (const waiter of waiters.splice(0)) waiter()
   await ack
   admission.acknowledged = true
  }
  for (const name of ['startPalComputer', 'stopPalComputer', 'cancel', 'readJob', 'stopJob'])
   api[name] = async () => { throw Error('Native or guest action forbidden in draft browser proof') }
  window.__draftProof = {
   admissions,
   waitForAdmission: async count => {
    while (admissions.length < count) await new Promise(resolve => { waiters.push(resolve) })
   },
   release: index => admissions[index].release(),
   saved: id => base.draft(owner(id)),
   fail: async index => {
    const admission = admissions[index]
    if ((revisions.get(admission.id) ?? 0) === admission.revision && !await base.draft(admission.id)) {
     await base.saveDraft(admission.id, admission.prompt)
     admission.restored = true
    }
    emit({
     kind: 'state', sessionId: admission.id, running: false, queued: [], queuedItems: [],
     error: 'Fixture engine preflight refused this prompt.',
     ...(admission.restored ? { restoredDraft: admission.prompt } : {}),
    })
   },
   staleRecovery: index => {
    const admission = admissions[index]
    emit({ kind: 'state', sessionId: admission.id, running: false, queued: [], queuedItems: [],
     error: 'Delayed fixture recovery notification.', restoredDraft: admission.prompt })
   },
  }
 } })
}

let context
let page
let currentCase
async function fresh(name) {
 currentCase = name
 if (context) await context.close()
 context = await browser.newContext({ viewport: { width: 1280, height: 850 }, colorScheme: 'dark' })
 await context.route('**/*', route => new URL(route.request().url()).origin === new URL(origin).origin
  ? route.continue() : route.abort())
 page = await context.newPage()
 page.setDefaultTimeout(12000)
 page.on('pageerror', error => receipt.pageErrors.push(error.message))
 await page.addInitScript(installFixture)
 await page.goto(origin)
 await expect(page.getByRole('status', { name: 'Design preview', exact: true })).toBeVisible()
 await page.locator('.sidebar-project-navigation').getByRole('button', { name: 'Refine navigation', exact: true }).click()
 await expect(page.getByRole('textbox', { name: 'Message Namzu', exact: true })).toBeEnabled()
}
const editor = () => page.getByRole('textbox', { name: 'Message Namzu', exact: true })
async function submit(prompt) {
 await editor().fill(prompt)
 await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
 await page.getByRole('button', { name: 'Send message', exact: true }).click()
 await page.evaluate(() => window.__draftProof.waitForAdmission(1))
 await expect(page.getByRole('button', { name: 'Sending', exact: true })).toBeDisabled()
}
async function assertSaved(id, expected) {
 assert.equal(await page.evaluate(id => window.__draftProof.saved(id), id), expected)
}
async function assertReleased() {
 await expect(page.getByRole('button', { name: 'Sending', exact: true })).toHaveCount(0)
 assert.equal(await page.evaluate(() => window.__draftProof.admissions[0].acknowledged), true)
}
async function record(name, id, expected, extra = {}) {
 await expect(editor()).toHaveValue(expected)
 await assertSaved(id, expected)
 receipt.checks.push({ name, textareaMatches: true, persistedDraftMatches: true, expectedLength: expected.length, ...extra })
}

try {
 const original = 'Synthetic draft recovery prompt.'
 const first = 'sample-thread-1'
 await fresh('failure before ACK')
 await submit(original)
 await page.evaluate(() => window.__draftProof.fail(0))
 await record('failure before ACK restores authored draft immediately', first, original)
 await page.evaluate(() => window.__draftProof.release(0))
 await assertReleased()
 await record('late success ACK cannot clear the earlier restored draft', first, original)

 await fresh('failure after ACK')
 await submit(original)
 await page.evaluate(() => window.__draftProof.release(0))
 await assertReleased()
 await record('normal admission clears the submitted draft before settlement', first, '')
 await page.evaluate(() => window.__draftProof.fail(0))
 await record('failure after ACK restores the authored draft', first, original)

 await fresh('newer edit during held ACK')
 await submit(original)
 const newer = 'A newer synthetic draft to retain.'
 await editor().fill(newer)
 await assertSaved(first, newer)
 await page.evaluate(() => window.__draftProof.fail(0))
 assert.equal(await page.evaluate(() => window.__draftProof.admissions[0].restored), false)
 await page.evaluate(() => window.__draftProof.staleRecovery(0))
 await record('newer draft rejects a delayed old restoration event', first, newer)
 await page.evaluate(() => window.__draftProof.release(0))
 await assertReleased()
 await record('newer draft survives the held admission ACK', first, newer)

 await fresh('explicit clear during held ACK')
 await submit(original)
 await editor().fill('')
 await assertSaved(first, '')
 await page.evaluate(() => window.__draftProof.fail(0))
 assert.equal(await page.evaluate(() => window.__draftProof.admissions[0].restored), false)
 await page.evaluate(() => window.__draftProof.staleRecovery(0))
 await record('explicitly cleared draft rejects delayed restoration', first, '')
 await page.evaluate(() => window.__draftProof.release(0))
 await assertReleased()
 await record('explicit clear remains empty after the held ACK', first, '')

 await fresh('same-prompt retype during held ACK')
 await submit(original)
 await editor().fill('')
 await editor().fill(original)
 await assertSaved(first, original)
 await page.evaluate(() => window.__draftProof.fail(0))
 assert.equal(await page.evaluate(() => window.__draftProof.admissions[0].restored), false)
 await page.evaluate(() => window.__draftProof.release(0))
 await assertReleased()
 await record('clear and retype of the identical prompt survives ACK by edit revision', first, original)

 await fresh('navigation owner isolation')
 await submit(original)
 await page.locator('.sidebar-project-navigation').getByRole('button', { name: 'Polish empty states', exact: true }).click()
 await expect(editor()).toBeEnabled()
 const second = 'sample-thread-2'
 const otherDraft = 'Independent synthetic draft in another conversation.'
 await editor().fill(otherDraft)
 await page.evaluate(() => window.__draftProof.fail(0))
 await page.evaluate(() => window.__draftProof.release(0))
 await assertReleased()
 await record('inactive owner recovery cannot replace the active owner draft', second, otherDraft)
 await assertSaved(first, original)
 await page.locator('.conversation-tab[data-tab-id="sample-thread-1"]').getByRole('tab', { name: 'Namzu: Refine navigation', exact: true }).click()
 await expect(editor()).toBeEnabled()
 await record('returning to the original owner reveals its restored draft', first, original, { otherOwnerPersisted: true })
 await assertSaved(second, otherDraft)

 assert.deepEqual(receipt.pageErrors, [])
 receipt.screenshot = 'send-draft-recovery-browser-20261006.png'
 await page.screenshot({ path: join(artifacts, receipt.screenshot) })
 receipt.passed = true
} catch (error) {
 receipt.error = { case: currentCase, name: error.name, message: error.message }
 receipt.debug = await page?.evaluate(() => ({
  editorLength: document.querySelector('[aria-label="Message Namzu"]')?.value.length,
  admissions: window.__draftProof?.admissions.map(({ acknowledged, restored, prompt }) => ({ acknowledged, restored, promptLength: prompt.length })),
 }))
 if (page) await page.screenshot({ path: join(artifacts, 'send-draft-recovery-failure-browser-20261006.png') })
 process.exitCode = 1
} finally {
 await writeFile(join(artifacts, 'send-draft-recovery-browser-proof-20261006.json'), JSON.stringify(receipt, null, 2) + '\n')
 if (context) await context.close()
 await browser.close()
 await server.close()
}
console.log(JSON.stringify({ passed: receipt.passed, checks: receipt.checks.length, error: receipt.error }))
