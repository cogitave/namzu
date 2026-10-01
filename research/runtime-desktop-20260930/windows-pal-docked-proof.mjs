// Read-only profiles in an owned private native Electron fixture, never the user's app home.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
assert.equal(process.platform, 'win32')
const root = dirname(fileURLToPath(import.meta.url))
assert.ok(root.includes('namzu-pal-onboarding-native-'))
const [electronPath, playwrightRoot, cliEntry] = process.argv.slice(2)
const require = createRequire(join(playwrightRoot, 'package.json'))
const { _electron } = require('playwright')
const { expect: checks } = require('playwright/test')
const expect = checks.configure({ timeout: 90000 })
const env = { ...process.env, NAMZU_HOME: join(root, 'state'), NAMZU_DESKTOP_CLI: cliEntry, NAMZU_DESKTOP_DEV_URL: 'http://127.0.0.1:5173/' }
delete env.ELECTRON_RUN_AS_NODE
let app, page
const checksPassed = [], faults = []
const receipt = { platform: process.platform, scope: 'Existing owned private profiles, native Electron/preload/Operator/ACP, current live renderer', modelRequests: 0, guestExecutions: 0, checks: checksPassed, faults }
try {
  app = await _electron.launch({ executablePath: electronPath, args: [join(root, 'app'), `--user-data-dir=${join(root, 'ui')}`], cwd: root, env, timeout: 90000 })
  page = await app.firstWindow()
  page.on('pageerror', error => faults.push(error.message))
  receipt.runtime = await app.evaluate(({ app, BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1322, 940)
    return { electron: process.versions.electron, pid: process.pid, userData: app.getPath('userData') }
  })
  const initial = await page.evaluate(() => window.namzu.pals())
  assert.equal(initial.length, 2)
  const identity = initial.find(pal => pal.name === 'Native Nami Edited')
  assert.ok(identity)
  await page.getByRole('complementary', { name: 'Projects and conversations', exact: true }).getByRole('button', { name: identity.name, exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'Pal context', exact: true })
  await expect(panel).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pal context', exact: true })).toHaveCount(0)
  await expect(page.locator('.pal-welcome-identity')).toHaveCount(0)
  await expect(panel.locator('.pal-character-scene-avatar')).toHaveAttribute('data-ready', 'true')
  checksPassed.push('persisted-profile-opens-with-always-visible-live-3D-right-panel')
  const geometry = await page.evaluate(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON()
    return { panel: box('.pal-context-card'), lane: box('.conversation-lane'), composer: box('.composer-wrap'), overflow: document.documentElement.scrollWidth > innerWidth }
  })
  assert.equal(geometry.overflow, false)
  assert.ok(geometry.panel.x >= geometry.lane.x + geometry.lane.width)
  assert.ok(geometry.composer.x + geometry.composer.width <= geometry.lane.x + geometry.lane.width + 1)
  receipt.geometry = geometry
  await page.screenshot({ path: join(root, 'docked-desktop.png') })
  const edit = panel.getByRole('button', { name: `Customize ${identity.name}`, exact: true })
  await expect(edit.locator('svg.lucide-pencil')).toHaveCount(1)
  await edit.click()
  const modal = page.getByRole('dialog', { name: 'Customize your Pal', exact: true })
  await expect(modal.getByRole('textbox', { name: 'Pal name', exact: true })).toHaveValue(identity.name)
  await expect(modal.getByRole('radio', { name: 'Spark', exact: true })).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
  await expect(edit).toBeFocused()
  checksPassed.push('pencil-opens-persisted-customization-and-restores-focus')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 800))
  await expect(panel).toBeVisible()
  await page.screenshot({ path: join(root, 'docked-laptop.png') })
  checksPassed.push('panel-remains-visible-at-laptop-width-without-a-toggle')
  assert.deepEqual(await page.evaluate(() => window.namzu.pals()), initial)
  assert.deepEqual(faults, [])
  receipt.passed = true
} catch (error) {
  receipt.passed = false; receipt.error = error.message; process.exitCode = 1
  if (page) await page.screenshot({ path: join(root, 'docked-failure.png') }).catch(() => {})
} finally {
  if (app) await app.close()
  receipt.completedAt = new Date().toISOString()
  await writeFile(join(root, 'docked-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, checks: checksPassed, error: receipt.error, faults }))
}
