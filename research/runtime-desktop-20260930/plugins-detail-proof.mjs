/** Full-page plugin detail proof using owned localhost preview data, never a native runtime. */
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
const captures = [], faults = [], results = {}
const rail = name => page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name, exact: true })
const listPage = () => page.getByRole('region', { name: 'Plugins', exact: true })
const rows = () => listPage().getByRole('list', { name: 'Installed plugins', exact: true }).getByRole('listitem')
const publicRows = () => listPage().getByRole('list', { name: 'Public plugins', exact: true }).getByRole('listitem')
const search = () => listPage().getByRole('searchbox', { name: 'Search plugins', exact: true })
const detailPage = () => page.locator('#plugin-details-content')
const openRow = name => listPage().getByRole('button', { name: `Open ${name} plugin`, exact: true })
const sidebar = () => page.getByRole('complementary', { name: 'Customize', exact: true })
const actionTrigger = name => listPage().getByRole('button', { name: `Actions for ${name}`, exact: true })
// Base UI labels the menu through its trigger; aria-labelledby takes precedence over aria-label.
const actionMenu = name => page.getByRole('menu', { name: `Actions for ${name}`, exact: true })
async function selectCollection(name) {
  const tab = listPage().getByRole('tab', { name, exact: true })
  if (await tab.getAttribute('aria-selected') !== 'true') await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}
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
async function information() {
  return await detailPage().locator('.plugin-details-information dl > div').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.querySelector('dt').textContent, node.querySelector('dd').textContent])))
}
async function assertDetails(name, expected) {
  await expect(detailPage()).toBeVisible()
  await expect(detailPage().getByRole('heading', { name, exact: true })).toBeFocused()
  await expect(detailPage().getByRole('navigation', { name: 'Plugin breadcrumb', exact: true })).toContainText(name)
  await expect(detailPage().getByRole('heading', { name: 'Information', exact: true })).toBeVisible()
  await expect(page.locator('.plugin-actions-menu')).toHaveCount(0)
  await expect(detailPage().getByRole('button', { name: /^(Install|Browse|Open marketplace)/i })).toHaveCount(0)
  await expect(detailPage().getByRole('heading', { name: /^(Apps|Marketplace)$/i })).toHaveCount(0)
  assert.deepEqual(await information(), expected)
}
async function back({ name, query, escape = false }) {
  if (escape) await page.keyboard.press('Escape')
  else await detailPage().getByRole('navigation', { name: 'Plugin breadcrumb', exact: true }).getByRole('button', { name: 'Plugins', exact: true }).click()
  await expect(detailPage()).toHaveCount(0)
  await expect(search()).toHaveValue(query)
  await expect(name ? openRow(name) : search()).toBeFocused()
}
async function refresh() {
  const before = await page.evaluate(() => window.__pluginDetailsQa.reads.length)
  await listPage().getByRole('button', { name: 'Refresh installed plugins', exact: true }).click()
  await page.waitForFunction(before => window.__pluginDetailsQa.reads.length > before, before)
  await expect(listPage().getByRole('button', { name: 'Refresh installed plugins', exact: true })).toBeEnabled()
}
async function switchProject(label) {
  await rail('Spaces').click()
  await page.getByRole('complementary', { name: 'Projects and conversations', exact: true }).getByRole('button', { name: `Open ${label}`, exact: true }).click()
  await rail('Plugins').click()
  await expect(listPage()).toBeVisible()
  await expect(detailPage()).toHaveCount(0)
  await selectCollection('Personal')
}
async function capture(name, { details = false, reduced = false } = {}) {
  await settle()
  const value = await page.evaluate(() => {
    const rect = node => node?.getBoundingClientRect().toJSON()
    const measure = node => {
      if (!node) return null
      const style = getComputedStyle(node)
      return { rect: rect(node), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, borderRightWidth: style.borderRightWidth, upperLeftRadius: style.borderTopLeftRadius, lowerLeftRadius: style.borderBottomLeftRadius, background: style.backgroundColor, fontSize: style.fontSize, lineHeight: style.lineHeight, textOverflow: style.textOverflow, overflow: style.overflow, overflowWrap: style.overflowWrap, whiteSpace: style.whiteSpace, animation: style.animationName, transition: style.transitionDuration }
    }
    const detail = document.querySelector('#plugin-details-content'), list = document.querySelector('#plugins-content')
    return {
      width: innerWidth, height: innerHeight, dark: document.documentElement.classList.contains('dark'), reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      overflow: document.documentElement.scrollWidth > innerWidth,
      rail: measure(document.querySelector('nav[aria-label="Main navigation"]')),
      sidebar: measure(document.querySelector('#namzu-plugins-sidebar')),
      workspace: measure(document.querySelector('.workspace')),
      list: measure(list), query: list?.querySelector('input[type="search"]')?.value,
      collections: list ? [...list.querySelectorAll('[role="tab"]')].map(node => ({ name: node.textContent, selected: node.getAttribute('aria-selected') })) : null,
      actionMenu: measure(document.querySelector('.plugin-actions-menu')),
      detail: measure(detail), body: measure(detail?.querySelector('.plugin-details-body')),
      heading: measure(detail?.querySelector('h1')), description: measure(detail?.querySelector('.plugin-details-description')),
      breadcrumb: measure(detail?.querySelector('.plugin-details-breadcrumb')), breadcrumbName: measure(detail?.querySelector('.plugin-details-breadcrumb > span')),
      information: detail ? [...detail.querySelectorAll('dl > div')].map(node => ({ name: node.querySelector('dt').textContent, value: node.querySelector('dd').textContent, ...measure(node) })) : null,
      rows: list ? [...list.querySelectorAll('.plugins-page-row')].map(node => ({ text: node.innerText, ...measure(node) })) : null,
      action: detail?.querySelector('.plugin-details-action') ? { label: detail.querySelector('.plugin-details-action').getAttribute('aria-label'), disabled: detail.querySelector('.plugin-details-action').disabled, busy: detail.querySelector('.plugin-details-action').getAttribute('aria-busy') } : null,
      focused: { tag: document.activeElement?.tagName, id: document.activeElement?.id, label: document.activeElement?.getAttribute('aria-label'), inert: Boolean(document.activeElement?.closest('[inert]')) },
      api: { reads: [...window.__pluginDetailsQa.reads], sends: window.__pluginDetailsQa.sends, syntheticChanges: [...window.__pluginDetailsQa.syntheticChanges], nativeChanges: window.__pluginDetailsQa.nativeChanges },
    }
  })
  assert.equal(value.overflow, false, `${name}: document stays within viewport`)
  assert.equal(value.rail.borderRightWidth, '0px')
  assert.equal(value.sidebar.borderRightWidth, '1px')
  assert.equal(value.sidebar.upperLeftRadius, '16px')
  assert.equal(value.sidebar.lowerLeftRadius, '16px')
  if (value.width < 768) {
    assert.equal(value.workspace.upperLeftRadius, '16px')
    assert.equal(value.workspace.lowerLeftRadius, '16px')
  }
  assert.equal(value.focused.inert, false)
  const current = details ? value.detail : value.list
  assert.ok(current && current.rect.left >= value.workspace.rect.left && current.rect.right <= value.workspace.rect.right + 1, `${name}: page belongs inside workspace`)
  assert.ok(current.scrollWidth <= current.clientWidth, `${name}: page has no concealed horizontal overflow`)
  if (details) {
    assert.equal(value.heading.fontSize, '20px')
    assert.equal(value.breadcrumbName.textOverflow, 'ellipsis')
    assert.equal(value.heading.overflowWrap, 'anywhere')
    assert.ok(value.body.rect.right <= current.rect.right + 1)
    for (const row of value.information) assert.ok(row.scrollWidth <= row.clientWidth, 'actual information remains bounded')
  }
  if (reduced) {
    assert.equal(value.reduced, true)
    if (details) assert.equal(value.body.animation, 'none')
  }
  await writeFile(join(artifacts, `plugins-detail-${name}.json`), JSON.stringify(value, null, 2) + '\n')
  await page.screenshot({ path: join(artifacts, `plugins-detail-${name}.png`) })
  captures.push({ name, ...value })
}

try {
  await page.goto(new URL('preview', origin).href)
  await expect(page.getByRole('status', { name: 'Design preview', exact: true })).toBeVisible()
  await page.evaluate(() => {
    const api = window.namzu, originalPlugins = api.plugins.bind(api)
    window.__pluginDetailsQa = { reads: [], sends: 0, syntheticChanges: [], nativeChanges: 0, mode: 'default', pending: null, state: null }
    const fixture = projectId => {
      const qa = window.__pluginDetailsQa
      if (qa.mode === 'long') return { plugins: [{ name: 'QA long plugin title ' + 'UnbrokenName'.repeat(12), description: 'Explicit synthetic description used to check wrapping on a narrow page. '.repeat(3).trim(), version: '', scope: 'project', status: 'error', startupError: 'Explicit synthetic startup error; no native plugin was executed.' }], live: false, canChange: false, notice: 'Explicit owned browser fixture, not installed packages.' }
      if (qa.mode === 'owner') return { plugins: [{ name: 'QA same-name plugin', description: `Explicit synthetic manifest owned by ${projectId}.`, version: projectId === 'sample-app' ? '1.0.0-A' : '2.0.0-B', scope: 'project', status: 'installed', startupEnabled: true }], live: false, canChange: false, notice: 'Explicit owned browser fixture, not installed packages.' }
      if (qa.state) return structuredClone(qa.state)
      return { plugins: [{ name: 'QA live plugin', description: 'Explicit synthetic live-state fixture; no native runtime is connected.', version: '7.0.0-fixture', scope: 'project', status: 'enabled', startupEnabled: false }, { name: 'QA other live plugin', description: 'Second fixture used to check that an admitted pending operation blocks other controls.', version: '7.0.0-fixture', scope: 'user', status: 'disabled', startupEnabled: true }], live: true, canChange: qa.mode === 'live', notice: 'Explicit synthetic live-state fixture, not a native runtime.' }
    }
    api.plugins = async (projectId, sessionId) => {
      window.__pluginDetailsQa.reads.push({ projectId, sessionId: sessionId ?? null, mode: window.__pluginDetailsQa.mode })
      if (window.__pluginDetailsQa.mode !== 'default') return fixture(projectId)
      const value = await originalPlugins(projectId, sessionId)
      window.__pluginDetailsQa.defaultInventory = structuredClone(value)
      return value
    }
    api.send = async () => { window.__pluginDetailsQa.sends++; throw new Error('This browser proof must not send model requests.') }
    api.setPluginEnabled = async (sessionId, name, enabled) => {
      const qa = window.__pluginDetailsQa
      if (qa.mode !== 'live') throw new Error('Only an explicit synthetic operation is allowed in this proof.')
      qa.syntheticChanges.push({ sessionId, name, enabled })
      const value = fixture('sample-app')
      value.plugins = value.plugins.map(plugin => plugin.name === name ? { ...plugin, status: enabled ? 'enabled' : 'disabled', startupEnabled: enabled } : plugin)
      return await new Promise(resolve => { qa.pending = () => { qa.state = value; qa.pending = null; resolve(structuredClone(value)) } })
    }
  })

  await rail('Plugins').click()
  await expect(listPage().getByRole('tab')).toHaveText(['Public', 'Personal'])
  await expect(listPage().getByRole('tab', { name: /^(All|Project)$/, exact: true })).toHaveCount(0)
  await selectCollection('Public')
  await expect(publicRows()).toHaveCount(3)
  const defaults = await page.evaluate(() => window.__pluginDetailsQa.defaultInventory)
  assert.deepEqual(await publicRows().locator('.plugins-page-row-title').allTextContents(), defaults.publicPlugins.map(plugin => plugin.name), 'Public is sourced from explicit catalogue data')
  await expect(listPage()).toContainText('This design preview uses sample catalogue entries.')
  await expect(listPage().getByRole('list', { name: 'Installed plugins', exact: true })).toHaveCount(0)
  const catalogName = defaults.publicPlugins[0].name
  await actionTrigger(catalogName).click()
  const publicMenu = actionMenu(catalogName)
  await expect(publicMenu.getByRole('menuitem')).toHaveText(['Try now', 'Manage', 'Uninstall'])
  await expect(publicMenu.getByRole('menuitem', { name: 'Try now', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await expect(publicMenu.getByRole('menuitem', { name: 'Uninstall', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await expect(publicMenu.getByRole('menuitem', { name: 'Uninstall', exact: true })).toHaveAttribute('title', 'Uninstall is not available in the desktop app yet.')
  await capture('wide-dark-public-catalog-actions')
  await page.keyboard.press('Escape')
  await expect(actionTrigger(catalogName)).toBeFocused()
  await actionTrigger(catalogName).click()
  await publicMenu.getByRole('menuitem', { name: 'Manage', exact: true }).click()
  await assertDetails(catalogName, { Version: defaults.publicPlugins[0].version })
  await expect(detailPage().getByRole('button', { name: /^(Enable|Disable) / })).toHaveCount(0)
  await back({ name: catalogName, query: '' })
  await search().fill(catalogName)
  await sidebar().getByRole('button', { name: 'Sample notes', exact: true }).click()
  await assertDetails('Sample notes', { Installation: 'Personal', Version: '1.0.0', Status: 'Installed', 'Starts next time': 'Saved setting unavailable' })
  await back({ name: 'Sample notes', query: '' })
  await expect(listPage().getByRole('tab', { name: 'Personal', exact: true })).toHaveAttribute('aria-selected', 'true')
  await selectCollection('Personal')
  await expect(rows()).toHaveCount(3)
  assert.deepEqual(await rows().locator('.plugins-page-row-title').allTextContents(), defaults.plugins.map(plugin => plugin.name), 'Personal includes all installed records, independently of installation scope')
  assert.deepEqual(defaults.plugins.map(plugin => plugin.scope), ['project', 'user', 'project'])
  await expect(listPage().getByRole('button', { name: /^(All|Project)$/, exact: true })).toHaveCount(0)
  await expect(listPage().getByRole('group', { name: 'Filter plugins by scope', exact: true })).toHaveCount(0)
  await expect(listPage().getByRole('heading', { name: 'Installed', exact: true })).toBeVisible()
  await capture('wide-dark-personal-installed-list')
  await actionTrigger('Sample project tools').click()
  const installedMenu = actionMenu('Sample project tools')
  await expect(installedMenu.getByRole('menuitem')).toHaveText(['Try now', 'Manage', 'Uninstall'])
  await expect(installedMenu.getByRole('menuitem', { name: 'Try now', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await expect(installedMenu.getByRole('menuitem', { name: 'Uninstall', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await installedMenu.getByRole('menuitem', { name: 'Manage', exact: true }).click()
  await assertDetails('Sample project tools', { Installation: 'Project', Version: '1.0.0', Status: 'Installed', 'Starts next time': 'Saved setting unavailable' })
  await back({ name: 'Sample project tools', query: '' })
  const beforeSearch = await page.evaluate(() => window.__pluginDetailsQa.reads.length)
  await search().fill('Sample project tools')
  await expect(rows()).toHaveCount(1)
  await openRow('Sample project tools').click()
  await assertDetails('Sample project tools', { Installation: 'Project', Version: '1.0.0', Status: 'Installed', 'Starts next time': 'Saved setting unavailable' })
  await expect(detailPage().getByRole('button', { name: /^(Enable|Disable) / })).toHaveCount(0)
  await capture('wide-dark-full-plugin-details', { details: true })
  await back({ name: 'Sample project tools', query: 'Sample project tools' })
  await openRow('Sample project tools').click()
  await expect(detailPage()).toBeVisible()
  await back({ name: 'Sample project tools', query: 'Sample project tools', escape: true })
  await sidebar().getByRole('button', { name: 'Sample notes', exact: true }).click()
  await assertDetails('Sample notes', { Installation: 'Personal', Version: '1.0.0', Status: 'Installed', 'Starts next time': 'Saved setting unavailable' })
  await back({ query: 'Sample project tools', escape: true })
  await sidebar().getByRole('button', { name: 'Sample notes', exact: true }).click()
  await expect(detailPage()).toBeVisible()
  await sidebar().getByRole('button', { name: 'Search plugins', exact: true }).click()
  await expect(search()).toHaveValue('Sample project tools')
  await expect(search()).toBeFocused()
  assert.equal(await page.evaluate(() => window.__pluginDetailsQa.reads.length), beforeSearch, 'search and opening details do not refetch or select a model')
  results.navigation = 'Row/sidebar full-page navigation, breadcrumb/Escape, retained search and appropriate row/search focus passed.'

  await page.evaluate(() => { window.__pluginDetailsQa.mode = 'owner' })
  await search().fill('')
  await refresh()
  await selectCollection('Public')
  await expect(listPage().getByRole('heading', { name: 'Public catalogue unavailable', exact: true })).toBeVisible()
  await expect(listPage()).toContainText('A public plugin catalogue is not connected yet. Your installed plugins are in Personal.')
  await expect(listPage().getByRole('list', { name: 'Public plugins', exact: true })).toHaveCount(0)
  await selectCollection('Personal')
  await openRow('QA same-name plugin').click()
  await assertDetails('QA same-name plugin', { Installation: 'Project', Version: '1.0.0-A', Status: 'Installed', 'Starts next time': 'Enabled' })
  await switchProject('Sample docs')
  await expect(rows()).toHaveCount(1)
  await openRow('QA same-name plugin').click()
  await assertDetails('QA same-name plugin', { Installation: 'Project', Version: '2.0.0-B', Status: 'Installed', 'Starts next time': 'Enabled' })
  await switchProject('Sample app')
  await expect(rows()).toHaveCount(1)
  await expect(detailPage()).toHaveCount(0)
  results.ownership = 'A→B→A project navigation with same-name synthetic manifests does not revive another owner’s detail page.'
  results.collections = 'Public uses explicit catalogue records; Personal includes both installation scopes; omitted public data shows the unavailable state rather than relabelling project plugins.'

  await rail('Spaces').click()
  await page.getByRole('button', { name: 'Refine navigation', exact: true }).click()
  await page.getByRole('textbox', { name: 'Message Namzu', exact: true }).fill('Plugin Try now retained sample draft')
  await page.evaluate(() => { window.__pluginDetailsQa.mode = 'guarded' })
  await rail('Plugins').click()
  await expect(rows()).toHaveCount(2)
  await openRow('QA live plugin').click()
  await assertDetails('QA live plugin', { Installation: 'Project', Version: '7.0.0-fixture', 'Current status': 'Enabled', 'Starts next time': 'Disabled' })
  await expect(detailPage().getByRole('button', { name: 'Disable QA live plugin', exact: true })).toBeDisabled()
  await expect(detailPage()).toContainText('Finish the active work before changing plugins.')
  await back({ name: 'QA live plugin', query: '' })
  await page.evaluate(() => { window.__pluginDetailsQa.mode = 'live' })
  await refresh()
  await actionTrigger('QA other live plugin').click()
  await expect(actionMenu('QA other live plugin').getByRole('menuitem', { name: 'Try now', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')
  await expect(actionTrigger('QA other live plugin')).toBeFocused()
  await actionTrigger('QA live plugin').click()
  await expect(actionMenu('QA live plugin').getByRole('menuitem', { name: 'Try now', exact: true })).not.toHaveAttribute('aria-disabled', 'true')
  await actionMenu('QA live plugin').getByRole('menuitem', { name: 'Try now', exact: true }).click()
  const composer = page.getByRole('textbox', { name: 'Message Namzu', exact: true })
  await expect(composer).toBeVisible()
  await expect(composer).toBeFocused()
  await expect(composer).toHaveValue('Plugin Try now retained sample draft')
  assert.equal(await page.evaluate(() => window.__pluginDetailsQa.sends), 0, 'Try now returns to the actual composer without sending')
  await rail('Plugins').click()
  await selectCollection('Personal')
  await expect(rows()).toHaveCount(2)
  results.actions = 'Exact Try now/Manage/Uninstall menu; catalogue, nonlive and disabled-plugin Try unavailable; uninstall unavailable without a host API; Manage opens scoped detail; enabled live Try returns to the real retained composer without sending; Escape restores the actions trigger.'
  await openRow('QA live plugin').click()
  const action = detailPage().getByRole('button', { name: 'Disable QA live plugin', exact: true })
  await expect(action).toBeEnabled()
  await action.click()
  await expect(action).toBeDisabled()
  await expect(action).toHaveAttribute('aria-busy', 'true')
  await action.dispatchEvent('click')
  assert.equal(await page.evaluate(() => window.__pluginDetailsQa.syntheticChanges.length), 1, 'pending synthetic operation cannot be admitted twice')
  await capture('wide-dark-live-busy-details', { details: true })
  await back({ name: 'QA live plugin', query: '' })
  await expect(listPage().getByRole('button', { name: 'Refresh installed plugins', exact: true })).toBeDisabled()
  await openRow('QA other live plugin').click()
  await expect(detailPage().getByRole('button', { name: 'Enable QA other live plugin', exact: true })).toBeDisabled()
  await page.evaluate(() => { window.__pluginDetailsQa.pending() })
  await expect(detailPage().getByRole('button', { name: 'Enable QA other live plugin', exact: true })).toBeEnabled()
  await back({ name: 'QA other live plugin', query: '' })
  await openRow('QA live plugin').click()
  await assertDetails('QA live plugin', { Installation: 'Project', Version: '7.0.0-fixture', 'Current status': 'Disabled', 'Starts next time': 'Disabled' })
  await back({ name: 'QA live plugin', query: '' })
  results.guards = 'Nonlive actions absent; actual live/canChange=false action disabled; one explicitly fake pending operation disables duplicate, other plugin, and refresh controls; completion restores controls. No native mutation occurred.'

  await page.evaluate(() => { window.__pluginDetailsQa.mode = 'long' })
  await refresh()
  const longName = await page.evaluate(() => 'QA long plugin title ' + 'UnbrokenName'.repeat(12))
  await rail('Profile').click()
  await page.getByRole('menuitemradio', { name: 'Light', exact: true }).click()
  await page.setViewportSize({ width: 600, height: 540 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await search().fill('QA long')
  await openRow(longName).click()
  await assertDetails(longName, { Installation: 'Project', Status: 'Unavailable', 'Starts next time': 'Saved setting unavailable' })
  await expect(detailPage().getByRole('heading', { name: 'Startup error', exact: true })).toBeVisible()
  await capture('narrow-light-long-details-reduced', { details: true, reduced: true })
  await back({ name: longName, query: 'QA long', escape: true })
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click()
  await expect(page.locator('#namzu-plugins-sidebar')).toHaveClass(/\bopen\b/)
  await expect(page.locator('.scrim')).toBeVisible()
  await sidebar().getByRole('button', { name: longName, exact: true }).click()
  await expect(detailPage()).toBeVisible()
  await expect(page.locator('#namzu-plugins-sidebar')).not.toHaveClass(/\bopen\b/)
  await expect(page.locator('.scrim')).toHaveCount(0)
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click()
  await expect(page.locator('#namzu-plugins-sidebar')).toHaveClass(/\bopen\b/)
  await sidebar().getByRole('button', { name: 'Search plugins', exact: true }).click()
  await expect(detailPage()).toHaveCount(0)
  await expect(page.locator('#namzu-plugins-sidebar')).not.toHaveClass(/\bopen\b/)
  await expect(page.locator('.scrim')).toHaveCount(0)
  await expect(search()).toBeVisible()
  await expect(search()).toBeFocused()
  await expect(search()).toHaveValue('QA long')
  await settle()
  assert.equal(await search().evaluate(node => {
    const rect = node.getBoundingClientRect()
    return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === node
  }), true, 'mobile returned search is exposed rather than covered by the sidebar')
  await openRow(longName).click()
  await expect(detailPage()).toBeVisible()
  await rail('Plugins').click()
  await expect(detailPage()).toHaveCount(0)
  await expect(search()).toHaveValue('QA long')
  await expect(page.locator('#namzu-plugins-sidebar')).not.toHaveClass(/\bopen\b/)
  await expect(page.locator('.scrim')).toHaveCount(0)
  results.mobileNavigation = 'Narrow sidebar plugin opens details and closes the overlay; sidebar Search returns the retained list, closes sidebar/scrim and exposes the focused input; active Plugins rail returns details to the list.'
  await capture('narrow-light-returned-list-reduced', { reduced: true })
  results.layout = 'Wide dark Public/Personal collections/full detail and narrow light long text remain inside the workspace; sidebar divider 1px, rail0, shared16px corners; reduced motion disables detail arrival.'
  const counts = await page.evaluate(() => ({ reads: window.__pluginDetailsQa.reads, sends: window.__pluginDetailsQa.sends, syntheticChanges: window.__pluginDetailsQa.syntheticChanges, nativeChanges: window.__pluginDetailsQa.nativeChanges }))
  assert.equal(counts.sends, 0)
  assert.equal(counts.nativeChanges, 0)
  assert.equal(counts.syntheticChanges.length, 1)
  assert.deepEqual(faults, [])
  const receipt = { passed: true, scope: 'Browser-only localhost design preview in one owned isolated context. Initial plugins are explicitly labelled development sample data. Ownership, live state and long text use injected synthetic manifests. The sole change dispatch resolves an owned-page fake promise; no native runtime, genuine installation, scheduler change, model request or real plugin mutation is claimed.', results, counts, captures, pageErrors: faults }
  await writeFile(join(artifacts, 'plugins-detail-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, captures: captures.length, receipt: join(artifacts, 'plugins-detail-receipt.json') }))
} catch (error) {
  await writeFile(join(artifacts, 'plugins-detail-receipt.json'), JSON.stringify({ passed: false, scope: 'Isolated localhost preview only; no native/model claim.', error: String(error), results, captures, pageErrors: faults }, null, 2) + '\n')
  throw error
} finally { await context.close(); await browser.close() }
