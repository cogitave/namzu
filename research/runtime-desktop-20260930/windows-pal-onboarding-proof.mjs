// Native Windows Electron proof. Uses a new private app/home and the live
// renderer, production preload/Operator and a built native CLI snapshot.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

assert.equal(process.platform, 'win32')
const root = dirname(fileURLToPath(import.meta.url))
const [electronPath, playwrightRoot, cliEntry] = process.argv.slice(2)
assert.ok(root.includes('namzu-pal-onboarding-native-'))
const require = createRequire(join(playwrightRoot, 'package.json'))
const { _electron } = require('playwright')
const { expect: checks } = require('playwright/test')
const expect = checks.configure({ timeout: 90000 })
const faults = []
const steps = []
const receipt = {
  platform: process.platform,
  scope: 'Owned native Windows Electron window, fresh private NAMZU_HOME/userData, live Vite renderer and production preload/Operator/native CLI',
  steps,
  faults,
  modelRequests: 0,
  guestExecutions: 0,
  limitations: ['Built consumer snapshot, not registry installation.', 'Onboarding and metadata only; real guest execution is covered by separate native proofs.'],
}
const env = { ...process.env, NAMZU_HOME: join(root, 'state'), NAMZU_DESKTOP_CLI: cliEntry, NAMZU_DESKTOP_DEV_URL: 'http://127.0.0.1:5173/' }
delete env.ELECTRON_RUN_AS_NODE
let desktop
let page
const note = (step, data = {}) => { steps.push({ step, ...data }); process.stdout.write(`${step}\n`) }
const sidebar = () => page.getByRole('complementary', { name: 'Projects and conversations', exact: true })
const modal = () => page.getByRole('dialog', { name: 'Customize your Pal', exact: true })
const customize = () => page.locator('.pal-welcome').getByRole('button', { name: 'Customize your Pal', exact: true })
async function launch() {
  desktop = await _electron.launch({ executablePath: electronPath, args: [join(root, 'app'), `--user-data-dir=${join(root, 'ui')}`], cwd: root, env, timeout: 90000 })
  page = await desktop.firstWindow()
  page.on('pageerror', error => faults.push(error.message))
  note('owned-native-window', await desktop.evaluate(({ app, BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1500, 940)
    return { platform: process.platform, electron: process.versions.electron, pid: process.pid, userData: app.getPath('userData') }
  }))
  assert.equal(await page.evaluate(() => typeof window.namzu?.createPal), 'function')
}
async function capture(name) { await page.screenshot({ path: join(root, `${name}.png`) }) }
try {
  await mkdir(join(root, 'state'), { recursive: true })
  await launch()
  await expect(sidebar().getByRole('button', { name: 'Create your first Pal', exact: true })).toBeEnabled()
  assert.equal(await sidebar().locator('.sidebar-pals-group').count(), 0)
  await sidebar().getByRole('button', { name: 'Create your first Pal', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Meet your Pal', exact: true })).toBeVisible()
  await expect(page.locator('.pal-welcome-message').last()).toHaveText('What would you like to call me?')
  await expect(page.locator('.pal-welcome-identity .pal-character-scene')).toHaveAttribute('data-ready', 'true')
  assert.equal(await page.locator('.composer textarea').count(), 0)
  note('chat-onboarding-before-inference-with-initialized-WebGL')
  const picker = page.locator('.pal-onboarding-model').getByRole('button', { name: 'Select model', exact: true })
  await expect(picker).toBeEnabled()
  await picker.click()
  await expect(page.locator('.model-picker-popup').getByRole('radio').first()).toBeVisible()
  await page.locator('.model-picker-popup').getByRole('radio').first().click()
  note('actual-native-provider-catalogue-selection')
  await capture('intro')
  await customize().click()
  await expect(modal().getByRole('textbox', { name: 'Pal name', exact: true })).toBeFocused()
  await modal().getByRole('textbox', { name: 'Pal name', exact: true }).fill('Native Nami')
  await modal().getByRole('radio', { name: 'Blue', exact: true }).check()
  await modal().getByRole('radio', { name: 'Sprout', exact: true }).check()
  await expect(modal().locator('.pal-character-scene')).toHaveAttribute('data-ready', 'true')
  await capture('customize')
  await modal().getByRole('button', { name: 'Save', exact: true }).click()
  await expect(modal()).toHaveCount(0)
  await expect(sidebar().getByRole('button', { name: 'Native Nami', exact: true })).toHaveAttribute('aria-current', 'page')
  const initial = (await page.evaluate(() => window.namzu.pals()))[0]
  assert.deepEqual(initial.appearance, { character: 'sprout', color: 'blue' })
  assert.ok(initial.model?.provider && initial.model?.model)
  note('native-renderer-IPC-Operator-ACP-persists-name-model-appearance', { appearance: initial.appearance, model: initial.model })
  await customize().click()
  await expect(modal().getByRole('textbox', { name: 'Pal name', exact: true })).toHaveValue('Native Nami')
  await expect(modal().getByRole('radio', { name: 'Blue', exact: true })).toBeChecked()
  await expect(modal().getByRole('radio', { name: 'Sprout', exact: true })).toBeChecked()
  await modal().getByRole('textbox', { name: 'Pal name', exact: true }).fill('Native Nami Edited')
  await modal().getByRole('radio', { name: 'Violet', exact: true }).check()
  await modal().getByRole('radio', { name: 'Spark', exact: true }).check()
  await modal().getByRole('button', { name: 'Save', exact: true }).click()
  await expect(modal()).toHaveCount(0)
  await expect(sidebar().getByRole('button', { name: 'Native Nami Edited', exact: true })).toBeVisible()
  await sidebar().getByRole('button', { name: 'New Pal', exact: true }).click()
  await customize().click()
  await modal().getByRole('textbox', { name: 'Pal name', exact: true }).fill('Native Pip')
  await modal().getByRole('button', { name: 'Save', exact: true }).click()
  await expect(modal()).toHaveCount(0)
  await expect(sidebar().getByRole('button', { name: 'Native Pip', exact: true })).toHaveAttribute('aria-current', 'page')
  assert.equal(await sidebar().locator('.sidebar-pals-group').count(), 0)
  note('second-native-Pal-unheaded-list-and-New-Pal-entry')
  await capture('saved')
  await desktop.close()
  desktop = undefined
  note('first-owned-window-and-ACP-closed')
  await launch()
  await expect(sidebar().getByRole('button', { name: 'Native Nami Edited', exact: true })).toBeVisible()
  await sidebar().getByRole('button', { name: 'Native Nami Edited', exact: true }).click()
  await customize().click()
  await expect(modal().getByRole('textbox', { name: 'Pal name', exact: true })).toHaveValue('Native Nami Edited')
  await expect(modal().getByRole('radio', { name: 'Violet', exact: true })).toBeChecked()
  await expect(modal().getByRole('radio', { name: 'Spark', exact: true })).toBeChecked()
  const persisted = await page.evaluate(() => window.namzu.pals())
  assert.equal(persisted.length, 2)
  assert.deepEqual(persisted.find(pal => pal.id === initial.id).model, initial.model)
  await capture('restart')
  note('native-process-restart-retains-two-profiles-model-and-customization')
  assert.deepEqual(faults, [])
  receipt.passed = true
} catch (error) {
  receipt.passed = false
  receipt.error = error.message
  process.exitCode = 1
  if (page) try { await capture('failure'); receipt.visibleText = (await page.locator('body').innerText()).slice(0, 7000) } catch {}
  console.error(error.message)
} finally {
  if (desktop) try { await desktop.close(); note('owned-native-window-and-ACP-closed') } catch (error) { receipt.closeError = error.message; process.exitCode = 1 }
  receipt.completedAt = new Date().toISOString()
  await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2))
  process.stdout.write(JSON.stringify({ passed: receipt.passed, steps: steps.length, faults, error: receipt.error }) + '\n')
}
