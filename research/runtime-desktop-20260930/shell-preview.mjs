/** Native shell and landing ownership proof. Only model/network I/O is scripted. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? '.')
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { _electron, expect } = require('@playwright/test')
const root = await mkdtemp('/tmp/namzu-shell-preview-')
const project = join(root, 'project'), secondProject = join(root, 'second-project'), home = join(root, 'namzu'), uiHome = join(root, 'desktop')
await mkdir(join(project, '.git'), { recursive: true })
await mkdir(join(secondProject, '.git'), { recursive: true })
await mkdir(home); await mkdir(uiHome)
await writeFile(join(project, 'namzu.config.json'), JSON.stringify({ sandbox: { enabled: false } }))
await writeFile(join(secondProject, 'namzu.config.json'), JSON.stringify({ sandbox: { enabled: false } }))
await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'anthropic', model: 'claude-sonnet-4-5' }], subagents: { active: [] } }))
const receipts = join(root, 'requests.jsonl')
const artifacts = join(repo, 'research/runtime-desktop-20260930/artifacts')
await mkdir(artifacts, { recursive: true })
const desktop = await _electron.launch({ executablePath: require('electron'), args: [join(repo, 'packages/desktop'), `--user-data-dir=${uiHome}`], env: { ...process.env, NAMZU_HOME: home, ANTHROPIC_API_KEY: 'synthetic-not-a-secret', NAMZU_DESKTOP_CLI: join(repo, 'research/runtime-desktop-20260930/fixtures/scripted-cli.mjs'), NAMZU_TEST_RECEIPTS: receipts } })
let closed = false
let probePage
const settleFrames = async (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const settleMotion = async (page) => page.evaluate(async () => { await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined))) })
const calls = async () => desktop.evaluate(() => structuredClone(globalThis.__shellCalls))
const admissions = async (method) => (await calls()).filter((call) => call.method === method)
async function holdCreation() {
  await desktop.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('namzu:newConversation')
    const control = { original, release: null, done: null, view: null, ready: null, admitted: null }
    control.ready = new Promise((resolve) => { control.admitted = resolve })
    globalThis.__shellHold = control
    ipcMain.removeHandler('namzu:newConversation')
    ipcMain.handle('namzu:newConversation', async (event, ...values) => {
      // The real operator creates its session; only delivery of its result is held.
      control.view = await original(event, ...values)
      control.admitted()
      await new Promise((resolve) => { control.release = resolve })
      try { return control.view } finally { control.done?.() }
    })
  })
}
async function createdView() {
  return desktop.evaluate(async () => { await globalThis.__shellHold.ready; return structuredClone(globalThis.__shellHold.view) })
}
async function releaseCreation() {
  await desktop.evaluate(async ({ ipcMain }) => {
    const control = globalThis.__shellHold
    if (!control?.view || !control.release) throw new Error('No real creation is held.')
    await new Promise((resolve) => { control.done = resolve; control.release() })
    ipcMain.removeHandler('namzu:newConversation')
    ipcMain.handle('namzu:newConversation', control.original)
    delete globalThis.__shellHold
  })
}
async function rejectCatalogOnce(projectId) {
  await desktop.evaluate(({ ipcMain }, projectId) => {
    const original = ipcMain._invokeHandlers.get('namzu:conversations')
    globalThis.__shellCatalogOriginal = original
    let rejected = false
    ipcMain.removeHandler('namzu:conversations')
    ipcMain.handle('namzu:conversations', (event, ...values) => {
      if (!rejected && values[0] === projectId) {
        rejected = true
        throw new Error('The isolated shell fixture rejected the conversation catalog once.')
      }
      return original(event, ...values)
    })
  }, projectId)
}
async function restoreCatalog() {
  await desktop.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('namzu:conversations')
    ipcMain.handle('namzu:conversations', globalThis.__shellCatalogOriginal)
    delete globalThis.__shellCatalogOriginal
  })
}
async function holdOtherProjectProviders(firstProjectId) {
  await desktop.evaluate(({ ipcMain }, firstProjectId) => {
    const original = ipcMain._invokeHandlers.get('namzu:providers')
    const control = { original, release: null, done: null, status: null, projectId: null, ready: null, admitted: null }
    control.ready = new Promise((resolve) => { control.admitted = resolve })
    globalThis.__shellProviderHold = control
    ipcMain.removeHandler('namzu:providers')
    ipcMain.handle('namzu:providers', async (event, ...values) => {
      if (values[0] === firstProjectId || values[1] !== undefined || control.projectId !== null) return original(event, ...values)
      control.projectId = values[0]
      control.status = await original(event, ...values)
      control.admitted()
      await new Promise((resolve) => { control.release = resolve })
      try { return control.status } finally { control.done?.() }
    })
  }, firstProjectId)
}
async function releaseOtherProjectProviders() {
  await desktop.evaluate(async ({ ipcMain }) => {
    const control = globalThis.__shellProviderHold
    if (!control?.status || !control.release) throw new Error('No real provider status is held.')
    await new Promise((resolve) => { control.done = resolve; control.release() })
    ipcMain.removeHandler('namzu:providers')
    ipcMain.handle('namzu:providers', control.original)
    delete globalThis.__shellProviderHold
  })
}
async function geometry(page, name) {
  await settleMotion(page); await settleFrames(page)
  const receipt = await page.evaluate(() => {
    const selectors = ['.app', '.window-titlebar', '.window-titlebar-menu', '.navigation-rail', '.sidebar', '.workspace', '.chat-stage', '[data-chat-composer-stack]', '[data-chat-composer-main-surface]', '.composer-input textarea', '.starter-actions', '.starter-actions button']
    return { width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, nodes: selectors.flatMap((selector) => [...document.querySelectorAll(selector)].map((node) => { const style = getComputedStyle(node); return { selector, text: node.textContent?.trim().slice(0, 100), rect: node.getBoundingClientRect().toJSON(), display: style.display, visibility: style.visibility, appRegion: style.getPropertyValue('-webkit-app-region'), transitionDuration: style.transitionDuration, color: style.color, background: style.backgroundColor, font: style.font, ariaHidden: node.getAttribute('aria-hidden') } })) }
  })
  await writeFile(join(artifacts, `shell-${name}-geometry.json`), JSON.stringify(receipt, null, 2) + '\n')
  await page.screenshot({ path: join(artifacts, `shell-${name}.png`) })
  return receipt
}
function rect(receipt, selector) { return receipt.nodes.find((node) => node.selector === selector).rect }
function inViewport(receipt, selector) {
  for (const node of receipt.nodes.filter((item) => item.selector === selector)) {
    assert.ok(node.rect.left >= -0.1 && node.rect.right <= receipt.width + 0.1, `${selector} is outside the horizontal viewport`)
    assert.ok(node.rect.top >= -0.1 && node.rect.bottom <= receipt.height + 0.1, `${selector} is outside the vertical viewport`)
  }
}
try {
  await desktop.evaluate(({ app, dialog, ipcMain }, args) => {
    app.setPath('userData', args.uiHome)
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [args.project] })
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    globalThis.__shellCalls = []
    globalThis.__shellRejectSelection = false
    for (const method of ['newConversation', 'selectProvider', 'send']) {
      const original = ipcMain._invokeHandlers.get(`namzu:${method}`)
      if (!original) throw new Error(`Missing real IPC handler: ${method}`)
      ipcMain.removeHandler(`namzu:${method}`)
      ipcMain.handle(`namzu:${method}`, async (event, ...values) => {
        const call = { method, values: structuredClone(values) }
        globalThis.__shellCalls.push(call)
        if (method === 'selectProvider' && globalThis.__shellRejectSelection) {
          globalThis.__shellRejectSelection = false
          call.rejected = true
          throw new Error('The isolated shell fixture rejected model selection once.')
        }
        const result = await original(event, ...values)
        call.result = structuredClone(result)
        return result
      })
    }
  }, { uiHome, project })
  const page = await desktop.firstWindow()
  probePage = page
  page.setDefaultTimeout(20_000)
  const faults = []; page.on('pageerror', (error) => faults.push(error.message))
  await expect(page.getByRole('heading', { name: 'What would you like to work on?', exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible()
  await page.getByRole('button', { name: 'Open a project', exact: true }).last().click()
  await expect(page.getByRole('button', { name: 'Review folder access', exact: true })).toBeVisible()
  assert.equal((await admissions('newConversation')).length, 0)
  await expect(page.getByRole('textbox', { name: 'Message Namzu', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Review folder access', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'Message Namzu', exact: true })
  await expect(input).toBeVisible()
  await expect(page.locator('.starter-actions')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Select model', exact: true })).toBeEnabled()
  const ownerProject = await page.evaluate(async () => (await window.namzu.projects())[0])
  assert.equal(ownerProject.trusted, true)
  assert.deepEqual(await page.evaluate((id) => window.namzu.conversations(id), ownerProject.id), [])
  const owner = `project:${ownerProject.id}`
  assert.deepEqual(await page.getByRole('navigation', { name: 'Window navigation', exact: true }).getByRole('button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))), ['Go back', 'Go forward', 'Toggle sidebar'])
  assert.deepEqual((await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))).slice(0, 3), ['Home', 'Projects', 'Conversations'])
  await expect(page.getByRole('button', { name: 'Toggle sidebar', exact: true })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'New thread', exact: true })).toHaveCount(0)
  const workspaceMenu = page.getByRole('button', { name: 'Workspace menu', exact: true })
  await workspaceMenu.click()
  await expect(page.getByRole('menuitem', { name: /Open project/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(workspaceMenu).toBeFocused()
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: 'Projects', exact: true }).click()
  await expect(page.locator('.sidebar')).toBeVisible()
  const wideToggle = page.getByRole('button', { name: 'Toggle sidebar', exact: true })
  await wideToggle.click()
  await expect(page.locator('.sidebar')).not.toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Main navigation', exact: true })).toBeVisible()
  await expect(wideToggle).toHaveAttribute('aria-expanded', 'false')
  await wideToggle.click()
  await expect(page.locator('.sidebar')).toBeVisible()
  await expect(wideToggle).toHaveAttribute('aria-expanded', 'true')
  await geometry(page, 'landing-empty')
  await input.fill('Retained landing draft')
  await expect(page.locator('.starter-actions')).not.toBeVisible()
  assert.equal(await page.evaluate((id) => window.namzu.draft(id), owner), 'Retained landing draft')
  await rejectCatalogOnce(ownerProject.id)
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('The isolated shell fixture rejected the conversation catalog once.')
  await expect(input).toHaveValue('Retained landing draft')
  assert.equal((await admissions('newConversation')).length, 0)
  await restoreCatalog()
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click()
  await page.reload()
  await expect(input).toHaveValue('Retained landing draft')
  await expect(page.getByRole('button', { name: 'Select model', exact: true })).toBeEnabled()
  await page.locator('.sidebar-new-conversation').click()
  await expect(input).toHaveValue('Retained landing draft')
  await input.press('Control+n')
  await expect(input).toHaveValue('Retained landing draft')
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Home', exact: true }).click()
  await expect(input).toHaveValue('Retained landing draft')
  assert.equal((await admissions('newConversation')).length, 0)
  await page.getByRole('button', { name: 'File', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: /New conversation/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await input.fill('Composition draft')
  await input.evaluate((node) => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })))
  await settleFrames(page)
  assert.equal((await admissions('newConversation')).length, 0)
  await input.press('Shift+Enter')
  await expect(input).toHaveValue('Composition draft\n')
  await input.fill('Run the foreground fixture.')
  await page.getByRole('button', { name: 'Select model', exact: true }).click()
  await page.getByRole('textbox', { name: 'Model', exact: true }).fill('claude-opus-4-7')
  await page.getByRole('button', { name: 'Use model', exact: true }).click()
  const wide = await geometry(page, 'landing-dark')
  assert.equal(wide.overflow, false)
  assert.equal(rect(wide, '.window-titlebar').height, 32)
  assert.equal(rect(wide, '.navigation-rail').width, 48)
  assert.equal(rect(wide, '.sidebar').width, 288)
  assert.equal(rect(wide, '.workspace').left, 336)
  assert.equal(wide.nodes.find((node) => node.selector === '.window-titlebar').appRegion, 'drag')
  assert.equal(wide.nodes.find((node) => node.selector === '.window-titlebar-menu').appRegion, 'no-drag')
  inViewport(wide, '.starter-actions button')
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
  const chrome = await page.evaluate(() => window.namzu.windowChrome())
  assert.equal(chrome.height, 32)
  assert.ok(['linux', 'darwin', 'win32', 'other'].includes(chrome.platform))
  console.log(JSON.stringify({ step: 'idle landing, project draft reload, menus, IME and wide geometry passed', root }))

  await holdCreation()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const first = await createdView()
  await input.fill('Typing that followed the first Send')
  await input.press('Enter')
  assert.equal((await admissions('newConversation')).length, 1)
  await releaseCreation()
  await expect(page.getByRole('region', { name: 'Tool approval', exact: true })).toBeVisible()
  await expect(input).toHaveValue('Typing that followed the first Send')
  assert.equal(await page.evaluate((id) => window.namzu.draft(id), first.id), 'Typing that followed the first Send')
  assert.equal(await page.evaluate((id) => window.namzu.draft(id), owner), '')
  const firstSend = await admissions('send')
  assert.deepEqual(firstSend.map((call) => call.values), [[first.id, 'Run the foreground fixture.']])
  assert.deepEqual((await admissions('selectProvider')).at(-1).values, [first.id, 'anthropic', 'claude-opus-4-7'])
  const approval = await geometry(page, 'approval-dark')
  assert.equal(approval.overflow, false)
  await page.getByRole('button', { name: 'Stop turn', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Tool approval', exact: true })).toHaveCount(0)
  console.log(JSON.stringify({ step: 'one create, one exact prompt, retained newer draft and real approval passed', session: first.id }))

  // A captured send continues only in its actual created session after navigation.
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Home', exact: true }).click()
  await expect(input).toHaveValue('')
  await input.fill('The captured navigation prompt')
  await holdCreation()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const second = await createdView()
  await page.locator('.conversations').getByRole('button', { name: 'Run the foreground fixture.', exact: true }).click()
  await expect(input).toHaveValue('Typing that followed the first Send')
  await input.fill('This draft belongs to the existing conversation')
  await releaseCreation()
  await expect(page.locator('[data-conversation-title]')).toHaveText('Run the foreground fixture.')
  await expect(input).toHaveValue('This draft belongs to the existing conversation')
  await page.evaluate(async (id) => { await window.namzu.openConversation((await window.namzu.projects())[0].id, id) }, second.id)
  await expect(page.locator('.conversations').getByRole('button', { name: 'The captured navigation prompt', exact: true })).toBeVisible()
  assert.equal((await admissions('newConversation')).length, 2)
  const secondSend = (await admissions('send')).at(-1)
  assert.deepEqual(secondSend.values, [second.id, 'The captured navigation prompt'])
  assert.equal(await page.evaluate((id) => window.namzu.draft(id), first.id), 'This draft belongs to the existing conversation')
  await page.locator('.conversations').getByRole('button', { name: 'The captured navigation prompt', exact: true }).click()
  await expect(page.locator('.message-text').filter({ hasText: 'Native runtime answered. DESKTOP_PIPE_OK' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop turn', exact: true })).toHaveCount(0)
  console.log(JSON.stringify({ step: 'navigation preserved active conversation and routed captured prompt to its own session', session: second.id }))

  // A rejected route leaves a real session and retry reuses that identity.
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Home', exact: true }).click()
  await input.fill('Retry the same created conversation')
  await desktop.evaluate(() => { globalThis.__shellRejectSelection = true })
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByText(/The isolated shell fixture rejected model selection once\./).first()).toBeVisible()
  await expect(page.locator('[data-conversation-title]')).toHaveText('New conversation')
  await expect(input).toHaveValue('Retry the same created conversation')
  const createCalls = await admissions('newConversation')
  assert.equal(createCalls.length, 3)
  const third = createCalls.at(-1).result
  assert.equal(await page.evaluate((id) => window.namzu.draft(id), third.id), 'Retry the same created conversation')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Tool approval', exact: true })).toBeVisible()
  assert.equal((await admissions('newConversation')).length, 3)
  assert.deepEqual((await admissions('send')).at(-1).values, [third.id, 'Retry the same created conversation'])
  await page.getByRole('button', { name: 'Stop turn', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Tool approval', exact: true })).toHaveCount(0)
  console.log(JSON.stringify({ step: 'route rejection preserves draft and retry session identity', session: third.id }))

  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Home', exact: true }).click()
  await input.fill('A readable light-theme landing draft')
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Appearance: dark. Change appearance', exact: true }).click()
  await expect(page.locator('html')).not.toHaveClass('dark')
  const light = await geometry(page, 'landing-light')
  assert.equal(light.overflow, false)
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(600, 540))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('.sidebar')).not.toBeVisible()
  const toggle = page.getByRole('button', { name: 'Toggle sidebar', exact: true })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(page.locator('.sidebar')).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const scrim = page.locator('.scrim')
  const scrimBounds = await scrim.boundingBox()
  assert.ok(scrimBounds)
  await scrim.click({ position: { x: scrimBounds.width - 8, y: scrimBounds.height / 2 } })
  await expect(page.locator('.sidebar')).not.toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle).toBeFocused()
  await expect(input).toHaveValue('A readable light-theme landing draft')
  const narrow = await geometry(page, 'landing-narrow-reduced')
  assert.equal(narrow.overflow, false)
  assert.equal(narrow.reducedMotion, true)
  assert.equal(rect(narrow, '.navigation-rail').width, 48)
  assert.equal(rect(narrow, '.workspace').left, 48)
  inViewport(narrow, '.composer-input textarea')
  inViewport(narrow, '.starter-actions button')
  assert.ok(narrow.nodes.filter((node) => ['.app', '.sidebar'].includes(node.selector)).every((node) => node.transitionDuration === '0s'))

  // A newly selected project must not borrow the old project's provider route.
  await desktop.evaluate(({ dialog }, secondProject) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [secondProject] })
  }, secondProject)
  await holdOtherProjectProviders(ownerProject.id)
  await input.press('Control+o')
  await page.getByRole('button', { name: 'Review folder access', exact: true }).click()
  await expect(input).toBeVisible()
  const secondProviderProject = await desktop.evaluate(async () => {
    await globalThis.__shellProviderHold.ready
    return globalThis.__shellProviderHold.projectId
  })
  const secondOwnerProject = await page.evaluate(async (path) => (await window.namzu.projects()).find((item) => item.path === path), secondProject)
  assert.ok(secondOwnerProject)
  assert.equal(secondProviderProject, secondOwnerProject.id)
  await expect(page.locator('[data-project-label]')).toHaveText('second-project')
  await expect(page.getByRole('button', { name: 'Select model', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Select model', exact: true })).toHaveText('Select model')
  await input.fill('Draft scoped to the second project while providers are loading')
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
  await input.press('Enter')
  await settleFrames(page)
  assert.equal((await admissions('newConversation')).length, 3)
  assert.equal((await admissions('send')).length, 3)
  assert.equal(await page.evaluate((id) => window.namzu.draft(`project:${id}`), secondOwnerProject.id), 'Draft scoped to the second project while providers are loading')
  await releaseOtherProjectProviders()
  await expect(page.getByRole('button', { name: 'Select model', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
  await expect(input).toHaveValue('Draft scoped to the second project while providers are loading')
  assert.equal((await admissions('newConversation')).length, 3)
  assert.equal((await admissions('send')).length, 3)
  assert.deepEqual(await page.evaluate((id) => window.namzu.conversations(id), secondOwnerProject.id), [])
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await expect(page.locator('[data-project-label]')).toHaveText('project')
  await expect(input).toHaveValue('A readable light-theme landing draft')
  await expect(page.locator('[data-conversation-title]')).toHaveText('Start a conversation')
  assert.equal((await admissions('newConversation')).length, 3)
  assert.equal((await admissions('send')).length, 3)
  await page.getByRole('button', { name: 'Go forward', exact: true }).click()
  await expect(page.locator('[data-project-label]')).toHaveText('second-project')
  await expect(input).toHaveValue('Draft scoped to the second project while providers are loading')
  await expect(page.locator('[data-conversation-title]')).toHaveText('Start a conversation')
  assert.equal((await admissions('newConversation')).length, 3)
  assert.equal((await admissions('send')).length, 3)
  console.log(JSON.stringify({ step: 'catalog failure preserves landing draft and second project waits for its own provider status', projectId: secondOwnerProject.id }))
  assert.deepEqual(faults, [])
  const requests = (await readFile(receipts, 'utf8')).trim().split('\n').map(JSON.parse)
  const agentRequests = requests.filter((request) => request.purpose === 'agent')
  assert.equal(agentRequests.length, 3)
  assert.ok(agentRequests.every((request) => request.model === 'claude-opus-4-7'))
  const result = { native: true, realCli: true, realKernel: true, modelIo: 'scripted', noExternalNetwork: true, root, windowChrome: chrome, headerButtonHierarchy: true, railButtonHierarchy: true, workspaceMenuFocusReturn: true, singleNewConversationButton: true, wideProjectsSidebarCanCollapse: true, actualBackForwardRestoresDraftOwners: true, starterActionsPreserveAuthoredDraft: true, landingBeforeSession: true, projectDraftReload: true, projectDraftSurvivesCatalogFailure: true, projectProviderAdmissionScoped: true, newActionsDoNotCreate: true, imeDoesNotSubmit: true, firstSendCreatesExactlyOne: true, newerTypingPreserved: true, consumedProjectDraftCleared: true, capturedNavigationTarget: true, retryKeepsCreatedIdentity: true, realApproval: true, dragRegionAndMenus: true, rendererNodeDisabled: true, darkLight: true, narrowPersistentRail: true, narrowDrawerOutsideClose: true, narrowDrawerFocusReturn: true, narrowAriaMatchesVisibility: true, reducedMotion: true, noOverflow: true, createdSessionIds: [first.id, second.id, third.id], calls: await calls(), requests }
  await desktop.close(); closed = true
  await writeFile(join(artifacts, 'shell-native-receipt.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} catch (error) {
  if (probePage && !probePage.isClosed()) {
    await Promise.allSettled([
      probePage.screenshot({ path: join(root, 'failure.png') }),
      probePage.evaluate(() => ({ active: document.activeElement?.outerHTML.slice(0, 2048), nodes: [...document.querySelectorAll('[data-slot="popover-popup"], .model-picker-trigger, [data-chat-composer-body], .composer-input textarea')].map((node) => ({ html: node.outerHTML.slice(0, 8192), visibility: getComputedStyle(node).visibility, display: getComputedStyle(node).display })) })).then((state) => writeFile(join(root, 'failure-state.json'), JSON.stringify(state, null, 2) + '\n')),
    ])
  }
  console.error(JSON.stringify({ failedProbeRoot: root }))
  throw error
} finally { if (!closed) await desktop.close() }
