/** Browser-only rail regression proof; synthetic plugin data stays inside this owned page. */
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
const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: 'dark' })
const page = await context.newPage()
const captures = [], faults = []
const input = () => page.getByRole('textbox', { name: 'Message Namzu', exact: true })
const rail = () => page.getByRole('navigation', { name: 'Main navigation', exact: true })
const control = (name) => rail().getByRole('button', { name, exact: true })
const pluginPage = () => page.getByRole('region', { name: 'Plugins', exact: true })
const pluginSearch = () => pluginPage().getByRole('searchbox', { name: 'Search installed plugins', exact: true })
const command = () => page.getByRole('dialog', { name: 'Search chats and actions', exact: true })
page.setDefaultTimeout(20000)
page.on('pageerror', error => faults.push(error.message))
await context.route('**/*', route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort())
await mkdir(artifacts, { recursive: true })
async function settle() {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished))
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  })
}
async function capture(name) {
  await settle()
  const value = await page.evaluate(() => {
    const rect = node => node?.getBoundingClientRect().toJSON()
    const nav = document.querySelector('nav[aria-label="Main navigation"]')
    const surface = node => {
      const bounds = node.getBoundingClientRect(), style = getComputedStyle(node)
      const corner = document.elementFromPoint(bounds.left + 1, bounds.top + 1)
      return { rect: rect(node), upperLeftRadius: style.borderTopLeftRadius, lowerLeftRadius: style.borderBottomLeftRadius, overflow: style.overflow, borderRightWidth: style.borderRightWidth, upperLeftPixelClipped: !node.contains(corner) }
    }
    return {
      width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
      dark: document.documentElement.classList.contains('dark'), reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      railBorderRightWidth: getComputedStyle(nav).borderRightWidth,
      rail: [...nav.querySelectorAll('button')].map(node => ({ label: node.getAttribute('aria-label'), current: node.getAttribute('aria-current'), expanded: node.getAttribute('aria-expanded'), disabled: node.getAttribute('aria-disabled'), rect: rect(node), transition: getComputedStyle(node).transitionDuration, filledIcon: Boolean(node.querySelector('svg[data-filled]')) })),
      focused: { label: document.activeElement?.getAttribute('aria-label'), text: document.activeElement?.textContent, inert: Boolean(document.activeElement?.closest('[inert]')) },
      newConversation: { marginTop: getComputedStyle(document.querySelector('.sidebar-new-conversation')).marginTop, headerGap: document.querySelector('.sidebar-new-conversation').getBoundingClientRect().top - document.querySelector('.sidebar-chrome').getBoundingClientRect().bottom },
      corners: { sidebar: surface(document.querySelector('.app').dataset.page === 'plugins' ? document.querySelector('#namzu-plugins-sidebar') : document.querySelector('.sidebar')), main: surface(document.querySelector('.workspace')) },
      sidebarCollapsed: document.querySelector('.app')?.getAttribute('data-sidebar-collapsed'),
      commandOpen: Boolean(document.querySelector('.command-palette-popup')),
      backgroundOpen: document.querySelector('.jobs-panel')?.getAttribute('data-open'),
      pluginsCalls: window.__railQa.pluginCalls,
      forbiddenMutationCalls: { send: window.__railQa.send, plugins: window.__railQa.pluginChanges, stopJob: window.__railQa.stopJob },
    }
  })
  assert.equal(value.overflow, false, `${name}: page stays in viewport`)
  assert.deepEqual(value.rail.map(row => row.label), ['Home', 'Spaces', 'Scheduled', 'Plugins', 'More', 'Profile'])
  assert.equal(value.focused.inert, false)
  await writeFile(join(artifacts, `rail-navigation-${name}.json`), JSON.stringify(value, null, 2) + '\n')
  await page.screenshot({ path: join(artifacts, `rail-navigation-${name}.png`) })
  captures.push({ name, ...value })
}
async function dismiss(opener) {
  await page.keyboard.press('Escape')
  await expect(opener).toBeFocused()
}
async function assertNoCommand() { await expect(command()).toHaveCount(0) }
try {
  await page.goto(new URL('preview', origin).href)
  await expect(page.getByRole('status', { name: 'Design preview', exact: true })).toBeVisible()
  await expect(rail()).toBeVisible()
  assert.deepEqual(await rail().getByRole('button').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['Home', 'Spaces', 'Scheduled', 'Plugins', 'More', 'Profile'])
  await expect(rail().getByRole('button', { name: 'Conversations', exact: true })).toHaveCount(0)
  await expect(rail().getByRole('button', { name: /Appearance|Update/ })).toHaveCount(0)
  await page.evaluate(() => {
    const api = window.namzu
    window.__railQa = { pluginCalls: [], pluginChanges: 0, openFolder: 0, send: 0, stopJob: 0, installedFixture: false }
    const plugins = api.plugins.bind(api), changes = api.setPluginEnabled.bind(api), send = api.send.bind(api), stop = api.stopJob.bind(api)
    api.plugins = async (projectId, sessionId) => {
      window.__railQa.pluginCalls.push({ projectId, sessionId: sessionId ?? null, fixture: window.__railQa.installedFixture ? 'synthetic-installed-inventory' : 'existing-preview-host' })
      if (!window.__railQa.installedFixture) {
        const value = await plugins(projectId, sessionId)
        window.__railQa.defaultSampleInventory = structuredClone(value)
        return value
      }
      return { plugins: [{ name: 'QA installed plugin', version: '1.0.0', description: 'Explicit read-only fixture for this isolated browser proof.', scope: 'project', status: 'installed', startupEnabled: true }], live: false, canChange: false, notice: 'Installed plugins. Their saved settings apply when this conversation starts.' }
    }
    api.setPluginEnabled = async (...args) => { window.__railQa.pluginChanges++; return await changes(...args) }
    api.send = async (...args) => { window.__railQa.send++; return await send(...args) }
    api.stopJob = async (...args) => { window.__railQa.stopJob++; return await stop(...args) }
    api.openProject = async () => { window.__railQa.openFolder++; return null }
  })
  await input().fill('Rail QA retained landing draft')
  await control('Spaces').click()
  await assertNoCommand()
  await expect(control('Spaces')).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('[data-project-group="sample-app"]')).toBeVisible()
  await control('Home').click()
  await assertNoCommand()
  await expect(control('Home')).toHaveAttribute('aria-current', 'page')
  await expect(input()).toHaveValue('Rail QA retained landing draft')
  await capture('wide-dark-home')
  assert.equal(captures.at(-1).corners.sidebar.upperLeftRadius, '16px')
  assert.equal(captures.at(-1).corners.sidebar.lowerLeftRadius, '16px')
  assert.equal(captures.at(-1).corners.sidebar.overflow, 'hidden')
  assert.equal(captures.at(-1).corners.sidebar.borderRightWidth, '0px')
  assert.equal(captures.at(-1).railBorderRightWidth, '0px')
  assert.equal(captures.at(-1).newConversation.marginTop, '4px')
  assert.equal(captures.at(-1).newConversation.headerGap, 4)

  const beforeSchedule = await page.locator('.jobs-panel').getAttribute('data-open')
  await expect(control('Scheduled')).toHaveAttribute('aria-disabled', 'true')
  await control('Scheduled').focus()
  await page.keyboard.press('Enter')
  await assertNoCommand()
  assert.equal(await page.locator('.jobs-panel').getAttribute('data-open'), beforeSchedule)
  await control('Scheduled').hover()
  await expect(page.locator('[data-slot="tooltip-popup"]')).toContainText('Scheduled — not available in the desktop app yet.')
  await control('Home').hover()

  await control('Plugins').click()
  await expect(control('Plugins')).toHaveAttribute('aria-current', 'page')
  await expect(pluginPage().getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible()
  await expect(pluginPage()).toContainText('No plugin runtime is connected in this design preview.')
  await expect(page.locator('[data-slot="popover-popup"]')).toHaveCount(0)
  await expect(pluginPage()).toContainText('The cards below use sample data.')
  await expect(pluginPage().getByRole('list', { name: 'Installed plugins', exact: true }).getByRole('listitem')).toHaveCount(3)
  await expect(pluginPage().getByRole('button', { name: /^(Enable|Disable) / })).toHaveCount(0)
  const defaults = await page.evaluate(() => window.__railQa.defaultSampleInventory)
  assert.deepEqual(defaults.plugins.map(item => ({ name: item.name, scope: item.scope })), [{ name: 'Sample project tools', scope: 'project' }, { name: 'Sample notes', scope: 'user' }, { name: 'Sample document tools', scope: 'project' }])
  assert.equal(defaults.live, false)
  assert.equal(defaults.canChange, false)
  await capture('default-sample-cards-wide-dark')
  await control('Home').click()
  await page.evaluate(() => { window.__railQa.installedFixture = true })
  await control('Plugins').click()
  await expect(pluginPage()).toContainText('QA installed plugin')
  await expect(pluginPage().getByRole('list', { name: 'Installed plugins', exact: true })).toContainText('Project')
  await expect(pluginPage().getByRole('button', { name: /^(Enable|Disable) / })).toHaveCount(0)
  await expect(page.getByRole('complementary', { name: 'Customize', exact: true })).toContainText('QA installed plugin')
  await capture('wide-dark-plugins')
  await pluginSearch().fill('No matching QA plugin')
  await expect(pluginPage().getByRole('heading', { name: 'No matching plugins', exact: true })).toBeVisible()
  await pluginPage().getByRole('button', { name: 'Clear filters', exact: true }).click()
  await expect(pluginSearch()).toHaveValue('')
  await pluginPage().getByRole('button', { name: 'Personal', exact: true }).click()
  await expect(pluginPage().getByRole('heading', { name: 'No matching plugins', exact: true })).toBeVisible()
  await pluginPage().getByRole('button', { name: 'Project', exact: true }).click()
  await expect(pluginPage().getByRole('list', { name: 'Installed plugins', exact: true })).toContainText('QA installed plugin')
  await pluginPage().getByRole('button', { name: 'All', exact: true }).click()
  const scope = await page.evaluate(() => window.__railQa.pluginCalls)
  assert.equal(scope.at(-1).projectId, 'sample-app')
  assert.equal(scope.at(-1).sessionId, null)
  await control('Home').click()
  await expect(input()).toHaveValue('Rail QA retained landing draft')

  await control('More').click()
  await expect(page.getByRole('menuitem', { name: 'Open folder…', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Toggle sidebar', exact: true })).toBeVisible()
  await page.getByRole('menuitem', { name: 'Open folder…', exact: true }).click()
  assert.equal(await page.evaluate(() => window.__railQa.openFolder), 1)
  await expect(control('More')).toBeFocused()
  const collapsed = await page.locator('.app').getAttribute('data-sidebar-collapsed')
  await control('More').click()
  await page.getByRole('menuitem', { name: 'Toggle sidebar', exact: true }).click()
  await expect(page.locator('.app')).toHaveAttribute('data-sidebar-collapsed', collapsed === 'true' ? 'false' : 'true')
  await expect(control('More')).toBeFocused()
  await capture('wide-dark-sidebar-collapsed')
  assert.equal(captures.at(-1).corners.main.upperLeftRadius, '16px')
  assert.equal(captures.at(-1).corners.main.lowerLeftRadius, '16px')
  assert.ok(['hidden', 'clip'].includes(captures.at(-1).corners.main.overflow))
  assert.equal(captures.at(-1).corners.main.upperLeftPixelClipped, true)
  await control('More').click()
  await page.getByRole('menuitem', { name: 'Toggle sidebar', exact: true }).click()
  await expect(page.locator('.app')).toHaveAttribute('data-sidebar-collapsed', collapsed)

  for (const appearance of ['Light', 'Dark', 'System']) {
    await control('Profile').click()
    await page.getByRole('menuitemradio', { name: appearance, exact: true }).click()
    await expect(control('Profile')).toBeFocused()
    assert.equal(await page.evaluate(() => localStorage.getItem('namzu.appearance')), appearance.toLowerCase())
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), appearance !== 'Light')
  }

  await page.getByRole('button', { name: 'Search conversations', exact: true }).click()
  await expect(command()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Search conversations', exact: true })).toBeFocused()
  await input().focus()
  await page.keyboard.press('Control+k')
  await expect(command()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(input()).toHaveValue('Rail QA retained landing draft')

  await page.getByRole('button', { name: 'Refine navigation', exact: true }).click()
  await input().fill('Rail QA retained conversation draft')
  await control('Spaces').click()
  await assertNoCommand()
  await control('Plugins').click()
  await expect(pluginPage()).toContainText('QA installed plugin')
  assert.deepEqual((await page.evaluate(() => window.__railQa.pluginCalls)).at(-1), { projectId: 'sample-app', sessionId: 'sample-thread-1', fixture: 'synthetic-installed-inventory' })
  await control('Home').click()
  await expect(input()).toHaveValue('Rail QA retained landing draft')
  assert.equal(await page.evaluate(() => window.namzu.draft('sample-thread-1')), 'Rail QA retained conversation draft')
  await page.getByRole('button', { name: 'Refine navigation', exact: true }).click()
  await expect(input()).toHaveValue('Rail QA retained conversation draft')
  await capture('wide-dark-retained-conversation')

  await control('Profile').click()
  await page.getByRole('menuitemradio', { name: 'Light', exact: true }).click()
  await page.setViewportSize({ width: 600, height: 540 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await control('Profile').click()
  await capture('narrow-light-profile-reduced')
  await dismiss(control('Profile'))
  await control('Plugins').click()
  await expect(pluginPage()).toContainText('QA installed plugin')
  await capture('narrow-light-plugins-reduced')
  await pluginSearch().focus()
  await page.keyboard.press('Control+k')
  await expect(command()).toBeVisible()
  await page.keyboard.press('Escape')
  await control('Spaces').click()
  await page.getByRole('button', { name: 'Refine navigation', exact: true }).click()
  await expect(input()).toHaveValue('Rail QA retained conversation draft')
  const counts = await page.evaluate(() => window.__railQa)
  assert.equal(counts.pluginChanges, 0)
  assert.equal(counts.send, 0)
  assert.equal(counts.stopJob, 0)
  assert.deepEqual(faults, [])
  const receipt = { passed: true, scope: 'Browser-only localhost preview, owned isolated context; no native kernel, real credentials, model calls, device folders or scheduler changes.', fixtures: { initialPlugins: 'Exactly three explicit dev-preview sample cards: two project and one personal; no genuine installed packages or executable runtime', installedPlugins: 'Explicit synthetic installed read-only manifest row injected only into owned page', openFolder: 'Explicit synthetic cancelled folder picker invocation' }, checks: ['Exact ordered rail destinations', 'No Conversations, standalone Appearance or fake Update', 'Home/Spaces do not open command search', 'Scheduled unavailable tooltip and no background pane mutation', 'Explicit default sample-card grid with honest sample notice and no runtime controls', 'Plugins destination, Customize sidebar, search/scope filters, ownership and no invented enable/disable action', 'More real sidebar toggle,16px clipping corners and cancelled folder-picker focus restoration', 'Profile actual theme state and restored focus', 'Header Search and Control+K retained', 'Landing/conversation drafts preserved', 'Wide dark and narrow light reduced motion'], counts, captures, pageErrors: faults }
  await writeFile(join(artifacts, 'rail-navigation-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, captures: captures.length, receipt: join(artifacts, 'rail-navigation-receipt.json') }))
} finally { await context.close(); await browser.close() }
