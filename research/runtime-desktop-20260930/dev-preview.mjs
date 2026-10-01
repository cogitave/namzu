/** Browser sample preview plus native grouped navigation and real CSS HMR. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? '.')
const origin = process.env.NAMZU_DESKTOP_DEV_URL ?? 'http://127.0.0.1:5173/'
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { _electron, chromium, expect: assertions } = require('@playwright/test')
const expect = assertions.configure({ timeout: 20000 })
const artifacts = join(repo, 'research/runtime-desktop-20260930/artifacts')
const root = await mkdtemp('/tmp/namzu-dev-preview-')
await mkdir(artifacts, { recursive: true })
const captures = [], faults = [], requests = []
let desktop, browser, page, cssPath
const frames = async () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
async function capture(name) {
  await frames()
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.allSettled(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity && !(animation.effect?.target instanceof HTMLInputElement)).map((animation) => animation.finished))
  })
  await frames()
  const geometry = await page.evaluate(() => ({
    width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    tokens: Object.fromEntries(['--chrome', '--background', '--sidebar', '--border', '--chat-max-width', '--font-sans', '--font-size-prompt', '--font-size-code'].map((token) => [token, getComputedStyle(document.documentElement).getPropertyValue(token).trim()])),
    nodes: ['.window-titlebar', '.navigation-rail', '.sidebar', '.workspace', '.topbar', '.conversation-body', '[data-chat-composer-main-surface]', '.sidebar-project-heading', '.conversation-row-state'].flatMap((selector) => [...document.querySelectorAll(selector)].map((node) => {
      const style = getComputedStyle(node)
      return { selector, rect: node.getBoundingClientRect().toJSON(), visible: !!node.getClientRects().length && style.visibility !== 'hidden', font: style.font, background: style.backgroundColor, border: style.border, radius: style.borderRadius, appRegion: style.getPropertyValue('-webkit-app-region'), minWidth: style.minWidth }
    }))
  }))
  assert.equal(geometry.overflow, false)
  assert.equal(geometry.nodes.find((node) => node.selector === '.navigation-rail').rect.width, 48)
  if (geometry.width >= 768) assert.equal(geometry.nodes.find((node) => node.selector === '.sidebar').rect.width, 288)
  await writeFile(join(artifacts, `dev-preview-${name}.json`), JSON.stringify(geometry, null, 2) + '\n')
  await page.screenshot({ path: join(artifacts, `dev-preview-${name}.png`) })
  captures.push({ name, ...geometry })
}
const input = () => page.getByRole('textbox', { name: 'Message Namzu', exact: true })
const search = () => page.getByRole('searchbox', { name: 'Search conversations', exact: true })
const group = (id) => page.locator(`[data-project-group="${id}"]`)
async function appearance(from) { await page.getByRole('button', { name: `Appearance: ${from}. Change appearance`, exact: true }).click() }

try {
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  await context.route('**/*', (route) => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort())
  page = await context.newPage(); page.setDefaultTimeout(20000)
  page.on('pageerror', (error) => faults.push(error.message))
  page.on('request', (request) => requests.push(request.url()))
  await page.goto(new URL('preview', origin).href)
  await expect(page.getByRole('status', { name: 'Design preview', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'What would you like to work on?', exact: true })).toBeVisible()
  await expect(page.locator('[data-project-group]')).toHaveCount(3)
  await expect(group('sample-app').getByRole('button', { name: 'Refine navigation', exact: true })).toBeVisible()
  await input().fill('Sample landing draft stays here')
  await page.getByRole('button', { name: 'Collapse Sample app conversations', exact: true }).click()
  await expect(group('sample-app').getByRole('button', { name: 'Refine navigation', exact: true })).not.toBeVisible()
  await expect(input()).toHaveValue('Sample landing draft stays here')
  assert.equal(await page.evaluate(() => window.namzu.draft('project:sample-app')), 'Sample landing draft stays here')
  await page.getByRole('button', { name: 'Open Sample docs', exact: true }).click()
  await expect(group('sample-docs').getByRole('button', { name: 'Improve the quick start', exact: true })).toBeVisible()
  await input().fill('Sample docs landing draft')
  await page.getByRole('button', { name: 'Expand Sample app conversations', exact: true }).click()
  await group('sample-app').getByRole('button', { name: 'Refine navigation', exact: true }).click()
  await expect(page.locator('.breadcrumb [data-conversation-title]')).toHaveText('Refine navigation')
  await expect(page.locator('.message-text')).toContainText(['Let’s work on refine navigation.', 'Sample conversation'])
  await input().fill('Sample conversation draft')
  await page.getByRole('button', { name: 'Collapse Sample app conversations', exact: true }).click()
  await expect(input()).toHaveValue('Sample conversation draft')
  await search().fill('Sample docs'); await expect(page.locator('[data-project-group]')).toHaveCount(1)
  await search().fill('quick start'); await expect(group('sample-docs').getByRole('button', { name: 'Improve the quick start', exact: true })).toBeVisible()
  await search().fill('no-such-thread'); await expect(page.locator('[data-project-group]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await expect(input()).toHaveValue('Sample docs landing draft')
  await page.getByRole('button', { name: 'Go forward', exact: true }).click()
  await expect(input()).toHaveValue('Sample conversation draft'); await expect(search()).toHaveValue('')
  await expect(group('sample-app').getByRole('button', { name: 'Refine navigation', exact: true })).toHaveAttribute('aria-current', 'page')
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open Sample app', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Select model', exact: true }).click()
  await page.getByRole('button', { name: 'Quick search', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search models', exact: true }).fill('focused')
  await page.getByRole('radio', { name: 'Sample provider Sample focused', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Select model', exact: true })).toContainText('Sample focused')
  const messageCount = await page.locator('.message-text').count()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.locator('body')).toContainText('This is a design preview. No message was sent to a model.')
  assert.equal(await page.locator('.message-text').count(), messageCount)
  await expect(input()).toHaveValue('Sample conversation draft')
  await capture('browser-grouped-dark')
  await appearance('dark'); await expect(page.locator('html')).not.toHaveClass('dark'); await capture('browser-grouped-light')
  await page.setViewportSize({ width: 600, height: 540 }); await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('.sidebar')).not.toBeVisible()
  await page.getByRole('button', { name: 'Projects', exact: true }).click(); await expect(page.locator('.sidebar')).toBeVisible()
  await capture('browser-narrow-light-reduced')
  await page.mouse.click(575, 300); await expect(page.locator('.sidebar')).not.toBeVisible()
  await appearance('light'); await expect(page.getByRole('button', { name: 'Appearance: system. Change appearance', exact: true })).toBeVisible()
  await appearance('system'); await expect(page.locator('html')).toHaveClass('dark')
  await capture('browser-narrow-dark-reduced')
  await browser.close(); browser = undefined
  console.log(JSON.stringify({ browserPreviewPassed: true }))

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
  await desktop.evaluate(({ app, dialog }, args) => {
    app.setPath('userData', args.ui)
    globalThis.__groupedProject = args.appProject
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.__groupedProject] })
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  }, { ui, appProject })
  page = await desktop.firstWindow(); page.setDefaultTimeout(20000)
  page.on('pageerror', (error) => faults.push(error.message))
  assert.equal(page.url(), origin)
  await expect(page.getByRole('status', { name: 'Design preview', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Open a project', exact: true }).last().click()
  await page.getByRole('button', { name: 'Review folder access', exact: true }).click()
  const firstProject = await page.evaluate(async () => (await window.namzu.projects())[0])
  // Seed real native sessions for navigation only, without any model request.
  const seed = async (projectId) => page.evaluate(async (id) => {
    const session = await window.namzu.newConversation(id)
    await window.namzu.saveDraftSettings(session.id, { choice: { provider: 'anthropic', model: 'claude-sonnet-4-5' }, options: { permissionMode: 'prompt' } })
    return session
  }, projectId)
  const first = await seed(firstProject.id)
  await desktop.evaluate((_, path) => { globalThis.__groupedProject = path }, docsProject)
  await page.getByRole('button', { name: 'File', exact: true }).click()
  await page.getByRole('menuitem', { name: /^Open project/ }).click()
  await page.getByRole('button', { name: 'Review folder access', exact: true }).click()
  const secondProject = await page.evaluate(async () => (await window.namzu.projects()).find((project) => project.name === 'docs-project'))
  const second = await seed(secondProject.id)
  await page.reload()
  await group(firstProject.id).getByRole('button', { name: 'New conversation', exact: true }).click()
  await input().fill('Owned first conversation draft')
  await page.getByRole('button', { name: 'Collapse app-project conversations', exact: true }).click()
  await expect(input()).toHaveValue('Owned first conversation draft')
  assert.equal(await page.evaluate((id) => window.namzu.draft(id), first.id), 'Owned first conversation draft')
  await page.getByRole('button', { name: 'Open docs-project', exact: true }).click()
  await group(secondProject.id).getByRole('button', { name: 'New conversation', exact: true }).click()
  await input().fill('Owned second conversation draft')
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  // Back first returns the intervening project landing; Back again opens the first owner.
  await expect(input()).toHaveValue('')
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await expect(input()).toHaveValue('Owned first conversation draft')
  await expect(group(firstProject.id).getByRole('button', { name: 'New conversation', exact: true })).toHaveAttribute('aria-current', 'page')
  await page.getByRole('button', { name: 'Go forward', exact: true }).click()
  await page.getByRole('button', { name: 'Go forward', exact: true }).click()
  await expect(input()).toHaveValue('Owned second conversation draft')
  await search().fill('app-project'); await expect(page.locator('[data-project-group]')).toHaveCount(1)
  await search().fill('New conversation'); await expect(page.locator('[data-project-group]')).toHaveCount(2)
  await search().fill('no-such-thread'); await expect(page.locator('[data-project-group]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await expect(input()).toHaveValue('Owned first conversation draft'); await expect(search()).toHaveValue('')
  await expect(group(firstProject.id).getByRole('button', { name: 'New conversation', exact: true })).toHaveAttribute('aria-current', 'page')
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open app-project', exact: true })).toBeFocused()
  await capture('native-grouped-dark')
  const documentIdentity = await page.evaluate(() => { window.__groupedHmrIdentity = crypto.randomUUID(); return window.__groupedHmrIdentity })
  cssPath = join(repo, 'research/runtime-desktop-20260930', `owned-hmr-${randomUUID()}.css`)
  await writeFile(cssPath, ':root { --namzu-native-hmr-probe: before; }\n')
  await page.evaluate(async (href) => { await import(href) }, new URL(`@fs${cssPath}?import`, origin).href)
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--namzu-native-hmr-probe').trim() === 'before')
  await writeFile(cssPath, ':root { --namzu-native-hmr-probe: after; }\n')
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--namzu-native-hmr-probe').trim() === 'after')
  assert.equal(await page.evaluate(() => window.__groupedHmrIdentity), documentIdentity)
  await expect(input()).toHaveValue('Owned first conversation draft')
  assert.equal(await page.evaluate((id) => window.namzu.draft(id), first.id), 'Owned first conversation draft')
  await unlink(cssPath); cssPath = undefined
  await appearance('dark'); await expect(page.locator('html')).not.toHaveClass('dark'); await capture('native-grouped-light')
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(600, 540))
  await page.emulateMedia({ reducedMotion: 'reduce' }); await expect(page.locator('.sidebar')).not.toBeVisible()
  await page.getByRole('button', { name: 'Projects', exact: true }).click(); await expect(page.locator('.sidebar')).toBeVisible()
  await capture('native-narrow-light-reduced')
  await page.mouse.click(575, 300); await expect(page.locator('.sidebar')).not.toBeVisible()
  await appearance('light'); await appearance('system'); await expect(page.locator('html')).toHaveClass('dark'); await capture('native-narrow-dark-reduced')
  let modelRequests = []
  try { modelRequests = (await readFile(receipts, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) } catch (error) { if (error.code !== 'ENOENT') throw error }
  assert.equal(modelRequests.length, 0)
  assert.deepEqual(faults, [])
  await desktop.close(); desktop = undefined
  const result = { root, devUrl: origin, browserPreview: true, sampleOnly: true, previewRefusesModelSend: true, actualNativeApi: true, seededSessions: 'Two explicit real native API sessions used as a navigation baseline; no model prompts', nativeModelRequests: 0, collapsePreservesOwnerAndDraft: true, projectAndTitleSearch: true, nonmatchingFilterClearedOnConversationSelection: true, selectedGroupOpened: true, projectsRailFocus: true, actualCssHmr: true, hmrRetainsDocumentAndNativeDraft: true, darkLightNarrowReduced: true, noOverflow: true, requests, captures }
  await writeFile(join(artifacts, 'dev-preview-native-receipt.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ complete: true, root, nativeModelRequests: 0 }))
} catch (error) {
  if (page && !page.isClosed()) await Promise.allSettled([page.screenshot({ path: join(root, 'failure.png') }), page.evaluate(() => ({ active: document.activeElement?.getAttribute('aria-label'), text: document.body.innerText })).then((value) => writeFile(join(root, 'failure.json'), JSON.stringify(value, null, 2)))])
  console.error(JSON.stringify({ failedProbeRoot: root })); throw error
} finally {
  if (cssPath) await unlink(cssPath)
  if (desktop) await desktop.close()
  if (browser) await browser.close()
}
