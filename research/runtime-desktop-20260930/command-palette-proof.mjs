/** Focused command navigation proof, with owned sample data and explicit native API seeds. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? '.')
const origin = process.env.NAMZU_DESKTOP_DEV_URL ?? 'http://127.0.0.1:5173/'
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { chromium, _electron, expect: assertions } = require('@playwright/test')
const expect = assertions.configure({ timeout: 20000 })
const artifacts = join(repo, 'research/runtime-desktop-20260930/artifacts')
const root = await mkdtemp('/tmp/namzu-command-palette-')
await mkdir(artifacts, { recursive: true })
let browser, desktop, page
const captures = [], faults = []
const input = () => page.getByRole('textbox', { name: 'Message Namzu', exact: true })
const searchButton = () => page.getByRole('button', { name: 'Search conversations', exact: true })
const dialog = () => page.getByRole('dialog', { name: 'Search chats and actions', exact: true })
const search = () => page.getByLabel('Search chats', { exact: true })
const item = (id) => page.locator(`[data-command-id="${id}"]`)
const group = (id) => page.locator(`[data-project-group="${id}"]`)
const rows = (id) => group(id).locator('[data-thread-item]')
async function selectAppearance(mode) {
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: 'Profile', exact: true }).click()
  const choice = page.getByRole('menuitemradio', { name: mode, exact: true })
  await expect(choice).toBeVisible()
  await choice.click()
  await expect(choice).toHaveCount(0)
}
async function settle() {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.allSettled(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity && !(animation.effect?.target instanceof HTMLInputElement)).map((animation) => animation.finished))
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  })
}
async function capture(name, { palette = true, reduced = false } = {}) {
  await settle()
  const geometry = await page.evaluate(() => {
    const rect = (node) => node?.getBoundingClientRect().toJSON()
    const popup = document.querySelector('.command-palette-popup')
    return {
      width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
      dark: document.documentElement.classList.contains('dark'), reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      popup: popup && { rect: rect(popup), overflow: popup.scrollWidth > popup.clientWidth, animation: getComputedStyle(popup).animationName, transition: getComputedStyle(popup).transitionDuration },
      list: rect(document.querySelector('.command-palette-list')),
      empty: { rect: rect(document.querySelector('.command-palette-empty')), text: document.querySelector('.command-palette-empty')?.textContent },
      search: rect(document.querySelector('[data-sidebar-search]')),
      brand: rect(document.querySelector('.sidebar-chrome')),
      groups: [...document.querySelectorAll('[data-project-group]')].map((node) => ({ id: node.getAttribute('data-project-group'), rect: rect(node), rows: [...node.querySelectorAll('[data-thread-item]')].map((row) => ({ rect: rect(row), text: row.innerText, active: !!row.querySelector('[aria-current="page"]') })) })),
      options: [...document.querySelectorAll('[data-command-id]')].map((node) => ({ id: node.getAttribute('data-command-id'), role: node.getAttribute('role'), disabled: node.getAttribute('aria-disabled'), rect: rect(node), text: node.innerText })),
      jobs: { rect: rect(document.querySelector('.jobs-panel')), open: document.querySelector('.jobs-panel')?.getAttribute('data-open') },
    }
  })
  assert.equal(geometry.overflow, false)
  assert.equal(geometry.reduced, reduced)
  if (geometry.width >= 768) {
    assert.equal(geometry.search.width, 28)
    assert.equal(geometry.search.height, 28)
    assert.equal(geometry.brand.right - geometry.search.right, 2)
  }
  if (palette) {
    assert.ok(geometry.popup)
    assert.equal(geometry.popup.overflow, false)
    assert.ok(geometry.popup.rect.x >= 0 && geometry.popup.rect.right <= geometry.width)
    assert.ok(geometry.popup.rect.y >= 0 && geometry.popup.rect.bottom <= geometry.height)
    assert.ok(Math.abs(geometry.popup.rect.x + geometry.popup.rect.width / 2 - geometry.width / 2) < 2)
    if (reduced) assert.equal(geometry.popup.transition, '0s')
    if (geometry.options.length > 0) {
      assert.equal(geometry.empty.text, '')
      assert.equal(geometry.empty.rect.height, 0)
      assert.ok(geometry.list.height >= geometry.popup.rect.height - 100)
    }
  }
  await writeFile(join(artifacts, `command-palette-${name}.json`), JSON.stringify(geometry, null, 2) + '\n')
  await page.screenshot({ path: join(artifacts, `command-palette-${name}.png`) })
  captures.push({ name, ...geometry })
}
async function openPalette() {
  await searchButton().click()
  await expect(dialog()).toBeVisible()
  await expect(search()).toBeFocused()
}
async function selectWithKeyboard(id) {
  await openPalette()
  await search().fill(id)
  await expect(item(`conversation:${id}`)).toBeVisible()
  await search().press('ArrowDown')
  await search().press('ArrowUp')
  await search().press('ArrowDown')
  await search().press('Enter')
  await expect(dialog()).toHaveCount(0)
}
async function exerciseJobs(name, draft, reduced = false) {
  await page.getByRole('button', { name: 'Background work', exact: true }).first().click()
  await expect(page.locator('.jobs-panel')).toBeVisible()
  await expect(page.locator('.jobs-panel')).toHaveAttribute('data-open', 'true')
  await expect(page.locator('.jobs-panel')).toContainText('No background shells in this conversation.')
  await capture(name, { palette: false, reduced })
  await page.getByRole('button', { name: 'Close background work', exact: true }).click()
  await expect(page.locator('.jobs-panel')).not.toBeVisible()
  await expect(page.locator('.jobs-panel')).toHaveAttribute('data-open', 'false')
  await expect(input()).toHaveValue(draft)
}
async function exerciseCap(projectId, projectName, targetId, draft, expectedTotal) {
  await selectWithKeyboard(targetId)
  await expect(input()).toHaveValue(draft)
  await expect(rows(projectId)).toHaveCount(6)
  await expect(group(projectId).locator('[aria-current="page"]')).toHaveCount(1)
  await page.getByRole('button', { name: `Show more ${projectName} conversations`, exact: true }).click()
  await expect(rows(projectId)).toHaveCount(expectedTotal)
  await page.getByRole('button', { name: `Collapse ${projectName} conversations`, exact: true }).click()
  await expect(input()).toHaveValue(draft)
  await page.getByRole('button', { name: `Expand ${projectName} conversations`, exact: true }).click()
  await expect(rows(projectId)).toHaveCount(expectedTotal)
  await page.getByRole('button', { name: `Show less ${projectName} conversations`, exact: true }).click()
  await expect(rows(projectId)).toHaveCount(6)
  await expect(input()).toHaveValue(draft)
}

try {
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  await context.route('**/*', (route) => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort())
  page = await context.newPage(); page.setDefaultTimeout(20000)
  page.on('pageerror', (error) => faults.push(error.message))
  await page.goto(new URL('preview', origin).href)
  await expect(page.getByRole('status', { name: 'Design preview', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'What would you like to work on?', exact: true })).toBeVisible()
  const extra = await page.evaluate(async () => {
    const seeded = []
    for (let index = 0; index < 6; index++) {
      const session = await window.namzu.newConversation('sample-app')
      await window.namzu.saveDraft(session.id, `Extra sample draft ${index + 1}`)
      seeded.push({ id: session.id, title: `Extra sample conversation ${index + 1}` })
    }
    const original = window.namzu.conversations.bind(window.namzu)
    let rejected = false
    window.namzu.conversations = async (id) => {
      if (id === 'sample-docs' && !rejected) { rejected = true; throw new Error('CONTROLLED_LIST_FAILURE_PRIVATE') }
      if (id === 'sample-workspace' && window.__qaHoldNextListing) {
        window.__qaHoldNextListing = false
        window.__qaHeldListing = true
        await new Promise((resolve) => { window.__qaReleaseListing = resolve })
        const result = (await original(id)).map((view) => ({ ...view, title: 'Stale closed listing sentinel' }))
        window.__qaHeldListingReturned = true
        return result
      }
      return (await original(id)).map((view) => ({ ...view, title: seeded.find((item) => item.id === view.id)?.title ?? view.title }))
    }
    return seeded
  })
  await input().fill('Sample project landing draft')
  await openPalette()
  await expect(dialog()).toContainText('Some conversations could not be loaded.')
  await expect(page.locator('body')).not.toContainText('CONTROLLED_LIST_FAILURE_PRIVATE')
  await search().fill('Improve the quick start')
  await expect(page.locator('[data-command-id^="conversation:"]')).toHaveCount(0)
  await capture('browser-partial-wide-dark')
  await search().fill('')
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(item('conversation:sample-thread-4')).toBeVisible()
  await search().fill('no-such-palette-conversation')
  await expect(page.locator('[data-command-id]')).toHaveCount(0)
  // Modal semantics intentionally remove the underlying composer from the accessibility tree.
  await expect(page.locator('textarea[aria-label="Message Namzu"]')).toHaveValue('Sample project landing draft')
  await search().press('Escape')
  await expect(dialog()).toHaveCount(0)
  await expect(searchButton()).toBeFocused()
  await expect(input()).toHaveValue('Sample project landing draft')
  await page.evaluate(() => { window.__qaHoldNextListing = true })
  await openPalette()
  await page.waitForFunction(() => window.__qaHeldListing)
  await expect(dialog()).toContainText('Loading conversations…')
  await page.keyboard.press('Escape'); await expect(dialog()).toHaveCount(0)
  await page.evaluate(() => window.__qaReleaseListing())
  await page.waitForFunction(() => window.__qaHeldListingReturned)
  await settle()
  await expect(page.locator('body')).not.toContainText('Stale closed listing sentinel')
  await expect(input()).toHaveValue('Sample project landing draft')
  // Existing loaded rows retain their admission order; newly indexed seeds were unshifted.
  const beyond = extra[0]
  await exerciseCap('sample-app', 'Sample app', beyond.id, 'Extra sample draft 1', 9)
  await input().fill('Selected sample follow-up draft')
  await openPalette()
  await search().fill('Improve the quick start')
  await item('conversation:sample-thread-4').click()
  await expect(dialog()).toHaveCount(0)
  await expect(page.locator('.breadcrumb [data-conversation-title]')).toHaveText('Improve the quick start')
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await expect(input()).toHaveValue('Selected sample follow-up draft')
  await input().focus(); await page.keyboard.press('Control+k')
  await expect(dialog()).toBeVisible(); await expect(search()).toBeFocused()
  await search().fill(beyond.id)
  await search().evaluate((node) => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, isComposing: true })))
  await expect(dialog()).toBeVisible()
  await search().press('End')
  await search().press('Shift+Home')
  assert.equal(await search().evaluate((node) => Math.abs(node.selectionEnd - node.selectionStart)), beyond.id.length)
  await search().fill('')
  await search().press('Tab')
  // The native focus guard first receives Tab; await the modal's actual focus return.
  await expect(search()).toBeFocused()
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.command-palette-popup')), true)
  await search().focus()
  await capture('browser-wide-dark')
  await item('open-project').scrollIntoViewIfNeeded()
  await expect(item('open-project')).toBeInViewport()
  await capture('browser-actions-wide-dark')
  await page.keyboard.press('Escape'); await expect(input()).toBeFocused()
  const countBeforeNew = await page.evaluate(async () => (await window.namzu.conversations('sample-app')).length)
  await openPalette(); await search().fill('no-such-filtered-action')
  await search().press('Control+n'); await expect(dialog()).toHaveCount(0)
  await expect(input()).toBeFocused()
  await expect(page.getByRole('heading', { name: 'What would you like to work on?', exact: true })).toBeVisible()
  assert.equal(await page.evaluate(async () => (await window.namzu.conversations('sample-app')).length), countBeforeNew)
  await expect(input()).toHaveValue('Sample project landing draft')
  await selectWithKeyboard(beyond.id); await expect(input()).toHaveValue('Selected sample follow-up draft')
  await exerciseJobs('browser-background-wide-dark', 'Selected sample follow-up draft')
  await selectAppearance('Light')
  await openPalette(); await capture('browser-wide-light')
  await page.mouse.click(15, 110); await expect(dialog()).toHaveCount(0); await expect(searchButton()).toBeFocused()
  await page.setViewportSize({ width: 600, height: 540 }); await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: 'Spaces', exact: true }).click()
  await expect(page.locator('.sidebar')).toBeVisible()
  await openPalette(); await capture('browser-narrow-light-reduced', { reduced: true })
  await page.keyboard.press('Escape'); await expect(searchButton()).toBeFocused()
  await page.getByRole('button', { name: 'Close sidebar', exact: true }).last().click()
  await selectAppearance('System')
  await selectAppearance('Dark')
  await input().focus(); await page.keyboard.press('Control+k')
  await expect(dialog()).toBeVisible(); await capture('browser-narrow-dark-reduced', { reduced: true })
  await page.keyboard.press('Escape'); await expect(input()).toBeFocused()
  await exerciseJobs('browser-background-narrow-dark-reduced', 'Selected sample follow-up draft', true)
  await page.setViewportSize({ width: 600, height: 380 })
  await input().focus(); await page.keyboard.press('Control+k')
  await expect(dialog()).toBeVisible(); await item('open-project').scrollIntoViewIfNeeded()
  await expect(item('open-project')).toBeInViewport()
  await capture('browser-short-dark-reduced', { reduced: true })
  await search().fill('no-short-viewport-match')
  await expect(page.locator('.command-palette-empty')).toContainText('No matching chats or actions.')
  await capture('browser-short-empty-dark-reduced', { reduced: true })
  await page.keyboard.press('Escape'); await expect(input()).toBeFocused()
  await browser.close(); browser = undefined

  const home = join(root, 'namzu'), ui = join(root, 'desktop')
  const appProject = join(root, 'app-project'), docsProject = join(root, 'docs-project')
  await mkdir(home); await mkdir(ui)
  for (const project of [appProject, docsProject]) {
    await mkdir(join(project, '.git'), { recursive: true })
    await writeFile(join(project, 'namzu.config.json'), JSON.stringify({ sandbox: { enabled: false } }))
  }
  await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'anthropic', model: 'claude-sonnet-4-5' }], subagents: { active: [] } }))
  const receipts = join(root, 'requests.jsonl')
  desktop = await _electron.launch({ executablePath: require('electron'), args: [join(repo, 'packages/desktop'), `--user-data-dir=${ui}`], env: { ...process.env, NAMZU_HOME: home, ANTHROPIC_API_KEY: 'synthetic-not-a-secret', NAMZU_DESKTOP_DEV_URL: origin, NAMZU_DESKTOP_CLI: join(repo, 'research/runtime-desktop-20260930/fixtures/scripted-cli.mjs'), NAMZU_TEST_RECEIPTS: receipts, NAMZU_TEST_COMPOSER: '1' } })
  await desktop.evaluate(({ app, dialog, ipcMain }, args) => {
    app.setPath('userData', args.ui)
    globalThis.__paletteProject = args.appProject
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.__paletteProject] })
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    const original = ipcMain._invokeHandlers.get('namzu:cancel')
    globalThis.__paletteCancelCalls = 0
    ipcMain.removeHandler('namzu:cancel')
    ipcMain.handle('namzu:cancel', (...args) => { globalThis.__paletteCancelCalls++; return original(...args) })
    const create = ipcMain._invokeHandlers.get('namzu:newConversation')
    globalThis.__paletteCreateCalls = 0
    ipcMain.removeHandler('namzu:newConversation')
    ipcMain.handle('namzu:newConversation', (...args) => { globalThis.__paletteCreateCalls++; return create(...args) })
  }, { ui, appProject })
  page = await desktop.firstWindow(); page.setDefaultTimeout(20000)
  page.on('pageerror', (error) => faults.push(error.message))
  assert.equal(page.url(), origin)
  await openPalette()
  await expect(item('new-conversation')).toHaveAttribute('aria-disabled', 'true')
  await search().press('Control+n'); await expect(dialog()).toBeVisible()
  await item('new-conversation').click({ force: true })
  await expect(dialog()).toBeVisible()
  assert.deepEqual(await page.evaluate(() => window.namzu.projects()), [])
  await page.keyboard.press('Escape'); await expect(searchButton()).toBeFocused()
  await page.getByRole('button', { name: 'Open a project', exact: true }).last().click()
  await page.getByRole('button', { name: 'Review folder access', exact: true }).waitFor()
  await page.keyboard.press('Control+n')
  assert.equal(await desktop.evaluate(() => globalThis.__paletteCreateCalls), 0)
  await expect(page.getByRole('button', { name: 'Review folder access', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Review folder access', exact: true }).click()
  const firstProject = await page.evaluate(async () => (await window.namzu.projects())[0])
  const seed = async (id, count) => page.evaluate(async ({ id, count }) => {
    const sessions = []
    for (let index = 0; index < count; index++) {
      const session = await window.namzu.newConversation(id)
      await window.namzu.saveDraftSettings(session.id, { choice: { provider: 'anthropic', model: 'claude-sonnet-4-5' }, options: { permissionMode: 'prompt' } })
      await window.namzu.saveDraft(session.id, `Owned native draft ${session.id}`)
      sessions.push(session)
    }
    return sessions
  }, { id, count })
  await seed(firstProject.id, 8)
  await desktop.evaluate((_, path) => { globalThis.__paletteProject = path }, docsProject)
  await page.getByRole('button', { name: 'File', exact: true }).click()
  await page.getByRole('menuitem', { name: /^Open project/ }).click()
  await page.getByRole('button', { name: 'Review folder access', exact: true }).click()
  const secondProject = await page.evaluate(async () => (await window.namzu.projects()).find((project) => project.name === 'docs-project'))
  const [second] = await seed(secondProject.id, 1)
  await page.reload()
  await expect(rows(firstProject.id)).toHaveCount(5)
  const ordered = await page.evaluate((id) => window.namzu.conversations(id), firstProject.id)
  const target = ordered.at(-1)
  await exerciseCap(firstProject.id, 'app-project', target.id, `Owned native draft ${target.id}`, 8)
  await input().fill('Actual native first owner edited draft')
  await openPalette(); await search().fill(second.id); await item(`conversation:${second.id}`).click()
  await expect(input()).toHaveValue(`Owned native draft ${second.id}`)
  await input().fill('Actual native second owner edited draft')
  await selectWithKeyboard(target.id)
  await expect(input()).toHaveValue('Actual native first owner edited draft')
  assert.equal(await page.evaluate((id) => window.namzu.draft(id), target.id), 'Actual native first owner edited draft')
  assert.equal(await page.evaluate((id) => window.namzu.draft(id), second.id), 'Actual native second owner edited draft')
  await openPalette(); await capture('native-wide-dark')
  await page.keyboard.press('Escape'); await expect(searchButton()).toBeFocused()
  // Native transport projection only: no model turn is launched to test modal Escape routing.
  await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('namzu:event', { kind: 'state', sessionId: id, running: true, queued: [], revision: 1000 }), target.id)
  await expect(page.getByRole('button', { name: 'Stop turn', exact: true })).toBeVisible()
  await input().focus(); await page.keyboard.press('Control+k'); await expect(dialog()).toBeVisible()
  await page.keyboard.press('Escape'); await expect(dialog()).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Stop turn', exact: true })).toBeVisible()
  assert.equal(await desktop.evaluate(() => globalThis.__paletteCancelCalls), 0)
  await expect(input()).toBeFocused()
  await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('namzu:event', { kind: 'state', sessionId: id, running: false, queued: [], revision: 1001 }), target.id)
  await expect(page.getByRole('button', { name: 'Stop turn', exact: true })).toHaveCount(0)
  await exerciseJobs('native-background-wide-dark', 'Actual native first owner edited draft')
  await selectAppearance('Light')
  await openPalette(); await capture('native-wide-light')
  await page.keyboard.press('Escape')
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(600, 540))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await input().focus(); await page.keyboard.press('Control+k')
  await expect(dialog()).toBeVisible(); await capture('native-narrow-light-reduced', { reduced: true })
  await page.keyboard.press('Escape'); await expect(input()).toBeFocused()
  await expect(input()).toHaveValue('Actual native first owner edited draft')
  await exerciseJobs('native-background-narrow-light-reduced', 'Actual native first owner edited draft', true)
  let requests = []
  try { requests = (await readFile(receipts, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) } catch (error) { if (error.code !== 'ENOENT') throw error }
  assert.equal(requests.length, 0)
  assert.deepEqual(faults, [])
  await desktop.close(); desktop = undefined
  const result = { root, currentFocusedProof: true, browserSampleApi: true, explicitNativeSessionSeeds: 'Eight app-project and one docs-project sessions, saved route/drafts, no prompts; actual native CLI/kernel session storage and navigation', nativeModelRequests: 0, runningEscape: 'Synthetic running-state event through native transport on an actual seeded owner; actual cancel IPC spy stayed zero. This does not claim a fresh model turn ran.', searchPartialNoticeAndRetry: true, closedListingArrivalIgnored: true, keyboardMouseAndFocusReturn: true, imeEnterKeepsModal: true, filteredCtrlNAndDisabledChord: true, shortcuts: 'Ctrl+K global and Ctrl+N while open tested; no Alt shortcuts are displayed by this palette', capIncludesActiveBeyondFirstFive: true, expandedListSurvivesCollapse: true, crossProjectNativeDraftOwnership: true, backgroundPaneWideNarrowKeepsDraft: true, noOverflow: true, captures }
  await writeFile(join(artifacts, 'command-palette-receipt.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ complete: true, root, nativeModelRequests: 0, captures: captures.length }))
} catch (error) {
  if (page && !page.isClosed()) await Promise.allSettled([page.screenshot({ path: join(root, 'failure.png') }), page.evaluate(() => document.body.innerText).then((text) => writeFile(join(root, 'failure.txt'), text))])
  console.error(JSON.stringify({ failedProbeRoot: root })); throw error
} finally {
  if (desktop) await desktop.close()
  if (browser) await browser.close()
}
