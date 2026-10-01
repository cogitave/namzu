/** Focused visual/interaction proof for compact plugin rows; only isolated development data. */
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
const captures = [], faults = []
const section = () => page.getByRole('region', { name: 'Plugins', exact: true })
const rows = () => section().getByRole('list', { name: 'Installed plugins', exact: true }).getByRole('listitem')
const search = () => section().getByRole('searchbox', { name: 'Search plugins', exact: true })
const rail = name => page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name, exact: true })
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
async function capture(name, { compact = true, wide = true } = {}) {
  await settle()
  const value = await page.evaluate(() => {
    const rect = node => node?.getBoundingClientRect().toJSON()
    const measure = node => {
      if (!node) return null
      const style = getComputedStyle(node)
      return { rect: rect(node), background: style.backgroundColor, borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth], radius: style.borderRadius, fontSize: style.fontSize, lineHeight: style.lineHeight, overflow: style.overflow, textOverflow: style.textOverflow, lineClamp: style.webkitLineClamp, shadow: style.boxShadow, transition: style.transitionDuration, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }
    }
    const root = document.querySelector('.plugins-page')
    const grid = root.querySelector('[aria-label="Installed plugins"]')
    const content = root.querySelector('.plugins-page-content') ?? root.querySelector('.plugin-details-body')
    const contentStyle = getComputedStyle(content)
    return {
      width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
      dark: document.documentElement.classList.contains('dark'), reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      content: { ...measure(content), paddingTop: contentStyle.paddingTop, paddingLeft: contentStyle.paddingLeft },
      search: measure(root.querySelector('.plugins-page-search')),
      collections: [...root.querySelectorAll('[role="tab"]')].map(node => ({ name: node.textContent, selected: node.getAttribute('aria-selected') })),
      scopeTabs: [...root.querySelectorAll('button')].filter(node => ['All', 'Project'].includes(node.textContent.trim())).map(node => node.textContent.trim()),
      grid: measure(grid),
      rows: grid ? [...grid.children].map(li => {
        const row = li.querySelector('.plugins-page-row') ?? li.firstElementChild ?? li
        return { text: li.innerText, row: measure(row), icon: measure(row.querySelector('.plugins-page-row-icon')), title: measure(row.querySelector('.plugins-page-row-title')), description: measure(row.querySelector('.plugins-page-row-description')), detailsButton: measure(row.querySelector('button')) }
      }) : [],
      details: measure(document.querySelector('#plugin-details-content')),
      focused: { tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label'), inert: Boolean(document.activeElement?.closest('[inert]')) },
      api: window.__pluginsQa,
    }
  })
  assert.equal(value.overflow, false, `${name}: viewport has no horizontal overflow`)
  assert.equal(value.focused.inert, false)
  if (compact) {
    assert.equal(value.search.rect.height, 32)
    assert.ok(Number.parseFloat(value.search.radius) >= 16, 'search is a pill')
    if (wide) assert.equal(value.content.paddingTop, '28px')
    assert.deepEqual(value.scopeTabs, [], 'installed list has no scope category tabs')
    assert.deepEqual(value.collections.map(tab => tab.name), ['Public', 'Personal'])
    assert.ok(value.rows.length > 0)
    for (const row of value.rows) {
      assert.equal(row.row.background, 'rgba(0, 0, 0, 0)', 'rows have no filled card surface')
      assert.deepEqual(row.row.borders, ['0px', '0px', '0px', '0px'], 'rows have no card border')
      assert.equal(row.row.shadow, 'none')
      assert.ok(row.row.rect.height >= 36 && row.row.rect.height <= 96, `${name}: bounded compact row height ${row.row.rect.height}`)
      assert.equal(row.icon.rect.width, 36)
      assert.equal(row.icon.rect.height, 36)
      assert.equal(row.title.fontSize, '14px')
      assert.equal(row.description.fontSize, '13px')
      assert.ok(row.row.scrollWidth <= row.row.clientWidth, 'row content stays within its allocation')
    }
    if (wide && value.rows.length > 1) {
      assert.equal(value.rows[0].row.rect.top, value.rows[1].row.rect.top, 'wide list uses two columns')
      assert.ok(value.rows[1].row.rect.left > value.rows[0].row.rect.right, 'columns have a real gap')
    }
  }
  await writeFile(join(artifacts, `plugins-reference-${name}.json`), JSON.stringify(value, null, 2) + '\n')
  await page.screenshot({ path: join(artifacts, `plugins-reference-${name}.png`) })
  captures.push({ name, ...value })
}
async function refresh() {
  const before = await page.evaluate(() => window.__pluginsQa.reads.length)
  await section().getByRole('button', { name: 'Refresh installed plugins', exact: true }).click()
  await page.waitForFunction(before => window.__pluginsQa.reads.length > before, before)
  return { before, after: await page.evaluate(() => window.__pluginsQa.reads.length) }
}
try {
  await page.goto(new URL('preview', origin).href)
  await expect(page.getByRole('status', { name: 'Design preview', exact: true })).toBeVisible()
  await page.evaluate(() => {
    const api = window.namzu, original = api.plugins.bind(api)
    window.__pluginsQa = { reads: [], changes: 0, sends: 0, longFixture: false }
    api.plugins = async (projectId, sessionId) => {
      window.__pluginsQa.reads.push({ projectId, sessionId: sessionId ?? null, source: window.__pluginsQa.longFixture ? 'explicit-long-data-fixture' : 'dev-preview-sample-inventory' })
      if (!window.__pluginsQa.longFixture) return await original(projectId, sessionId)
      return {
        plugins: [
          { name: 'QA controlled long plugin name '.repeat(10).trim(), version: '1.0.0', scope: 'project', status: 'installed', description: 'Controlled synthetic description with several words that must remain readable within a compact row. '.repeat(16).trim() },
          { name: 'QA personal plugin', version: '1.0.0', scope: 'user', status: 'installed', description: 'A second explicit fixture keeps the wide two-column comparison meaningful.' },
        ], live: false, canChange: false, notice: 'Explicit synthetic inventory for this isolated browser proof. No plugin runtime is running.'
      }
    }
    api.setPluginEnabled = async () => { window.__pluginsQa.changes++; throw new Error('This proof must not mutate plugins.') }
    api.send = async () => { window.__pluginsQa.sends++; throw new Error('This proof must not send model requests.') }
  })
  await rail('Plugins').click()
  await section().getByRole('tab', { name: 'Personal', exact: true }).click()
  await expect(section().getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible()
  await expect(rows()).toHaveCount(3)
  await expect(section()).toContainText('The plugins below use sample data.')
  await expect(section().getByRole('button', { name: /^(Enable|Disable|Install|Browse marketplace)/ })).toHaveCount(0)
  await expect(section().getByRole('heading', { name: 'Installed', exact: true })).toBeVisible()
  await page.getByRole('complementary', { name: 'Customize', exact: true }).getByRole('button', { name: 'Search plugins', exact: true }).click()
  await expect(search()).toBeFocused()
  await expect(page.locator('.command-palette-popup')).toHaveCount(0)
  await capture('wide-dark-default-rows')
  const defaultReads = await page.evaluate(() => window.__pluginsQa.reads.length)
  await expect(section().getByRole('button', { name: /^(All|Project)$/, exact: true })).toHaveCount(0)
  await search().fill('Sample notes')
  await expect(rows()).toHaveCount(1)
  await search().fill('no-such-plugin')
  await expect(section().getByRole('heading', { name: 'No matching plugins', exact: true })).toBeVisible()
  await section().getByRole('button', { name: 'Clear search', exact: true }).click()
  assert.equal(await page.evaluate(() => window.__pluginsQa.reads.length), defaultReads, 'local search does not refetch inventory')
  const refreshed = await refresh()
  assert.equal(refreshed.after, refreshed.before + 1, 'refresh dispatches a real inventory read')
  await expect(rows()).toHaveCount(3)

  const opener = rows().first().getByRole('button', { name: /^Actions for / })
  await opener.click()
  await page.getByRole('menuitem', { name: 'Manage', exact: true }).click()
  const details = page.locator('#plugin-details-content')
  await expect(details).toBeVisible()
  await expect(details).toContainText('Sample project tools')
  await expect(details).toContainText('Project')
  await expect(details.getByRole('button', { name: /^(Enable|Disable|Install)/ })).toHaveCount(0)
  await capture('wide-dark-plugin-details', { compact: false })
  await page.keyboard.press('Escape')
  await expect(details).toHaveCount(0)
  await expect(rows().first().getByRole('button', { name: /^Open .* plugin$/ })).toBeFocused()

  await page.evaluate(() => { window.__pluginsQa.longFixture = true })
  await refresh()
  await expect(rows()).toHaveCount(2)
  await capture('wide-dark-long-fixture')
  await rail('Profile').click()
  await page.getByRole('menuitemradio', { name: 'Light', exact: true }).click()
  await page.setViewportSize({ width: 600, height: 540 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await capture('narrow-light-long-fixture-reduced', { wide: false })
  const counts = await page.evaluate(() => window.__pluginsQa)
  assert.equal(counts.changes, 0)
  assert.equal(counts.sends, 0)
  assert.deepEqual(faults, [])
  const receipt = { passed: true, scope: 'Browser-only localhost design preview in one owned context. Default rows are explicit sample plugins; long names/descriptions are an isolated synthetic fixture. No native runtime, genuine installed plugin, device credentials, scheduler change or model request is claimed.', checks: ['Compact transparent borderless rows with reference typography/icon/search dimensions', 'Wide two-column layout and narrow bounded long text', 'Personal installed section and honest sample notice', 'Public/Personal collections and search without unnecessary host reads', 'Explicit refresh reads the existing inventory API', 'Actual full plugin details and Escape focus restoration', 'No invented marketplace/installer controls or plugin/model mutation'], refreshed, counts, captures, pageErrors: faults }
  await writeFile(join(artifacts, 'plugins-reference-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, captures: captures.length, receipt: join(artifacts, 'plugins-reference-receipt.json') }))
} finally { await context.close(); await browser.close() }
