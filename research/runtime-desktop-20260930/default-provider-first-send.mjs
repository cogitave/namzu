/** Real Electron/CLI/kernel first send with a provider default and no model picker interaction. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? '.')
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { _electron, expect: assertions } = require('@playwright/test')
// Native subprocess and filesystem I/O uses Playwright's own assertion timeout.
const expect = assertions.configure({ timeout: 20000 })
const root = await mkdtemp('/tmp/namzu-default-provider-send-')
const project = join(root, 'project'), home = join(root, 'namzu'), ui = join(root, 'desktop')
await mkdir(join(project, '.git'), { recursive: true })
await mkdir(home)
await mkdir(ui)
await writeFile(join(project, 'namzu.config.json'), JSON.stringify({ sandbox: { enabled: false } }))
await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'anthropic' }], subagents: { active: [] } }))
const requests = join(root, 'requests.jsonl')
const desktop = await _electron.launch({
  executablePath: require('electron'),
  args: [join(repo, 'packages/desktop'), `--user-data-dir=${ui}`],
  env: { ...process.env, NAMZU_HOME: home, ANTHROPIC_API_KEY: 'synthetic-not-a-secret', NAMZU_DESKTOP_CLI: join(repo, 'research/runtime-desktop-20260930/fixtures/scripted-cli.mjs'), NAMZU_TEST_RECEIPTS: requests, NAMZU_TEST_COMPOSER: '1' },
})
const faults = []
let receipt
try {
  await desktop.evaluate(({ dialog, ipcMain }, project) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] })
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    globalThis.__defaultProviderAdmissions = []
    for (const method of ['saveDraftSettings', 'selectProvider', 'send']) {
      const original = ipcMain._invokeHandlers.get(`namzu:${method}`)
      if (!original) throw new Error(`Missing actual IPC handler ${method}`)
      ipcMain.removeHandler(`namzu:${method}`)
      ipcMain.handle(`namzu:${method}`, async (event, ...values) => {
        globalThis.__defaultProviderAdmissions.push({ method, values: structuredClone(values) })
        return original(event, ...values)
      })
    }
  }, project)
  const page = await desktop.firstWindow()
  page.setDefaultTimeout(20000)
  page.on('pageerror', (error) => faults.push(error.message))
  await page.getByRole('button', { name: 'Open a project', exact: true }).last().click()
  await page.getByRole('button', { name: 'Review folder access', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Select model', exact: true })).toBeEnabled()
  const context = await page.evaluate(async () => {
    const project = (await window.namzu.projects())[0]
    return { project, status: await window.namzu.providers(project.id) }
  })
  assert.equal(context.status.selected.id, 'anthropic')
  assert.equal(context.status.selected.model, undefined, 'CLI selected provider must have no explicit model')
  const defaultModel = context.status.available.find((provider) => provider.id === 'anthropic').defaultModel
  assert.ok(defaultModel)
  await page.getByRole('textbox', { name: 'Message Namzu', exact: true }).fill('DEFAULT_PROVIDER_FIRST_SEND_OK')
  await page.getByRole('textbox', { name: 'Message Namzu', exact: true }).press('Enter')
  await expect(page.locator('.message-text').filter({ hasText: 'Composer fixture answered.' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Stop turn', exact: true })).toHaveCount(0)
  const admissions = await desktop.evaluate(() => structuredClone(globalThis.__defaultProviderAdmissions))
  const sent = admissions.find((item) => item.method === 'send')
  assert.ok(sent, 'Actual main send must be admitted')
  const selection = admissions.find((item) => item.method === 'selectProvider')
  assert.deepEqual(selection.values.slice(1), ['anthropic', defaultModel])
  const settings = await page.evaluate((id) => window.namzu.draftSettings(id), sent.values[0])
  assert.equal(settings.choice.model, defaultModel)
  const lines = (await readFile(requests, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  const request = lines.find((item) => item.purpose === 'agent')
  assert.ok(request)
  assert.equal(request.model, defaultModel)
  assert.equal(request.users.at(-1).text, 'DEFAULT_PROVIDER_FIRST_SEND_OK')
  assert.deepEqual(faults, [])
  receipt = { native: true, realCli: true, realKernel: true, modelNetworkIo: 'scripted', modelPickerOpened: false, selectedProviderHadNoExplicitModel: true, defaultModel, firstSendAdmitted: true, persistedDefaultMatchesActualRequest: true, sessionId: sent.values[0], root, faults }
} finally {
  await desktop.close()
}
await writeFile(join(repo, 'research/runtime-desktop-20260930/artifacts/default-provider-first-send-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(receipt)}\n`)
