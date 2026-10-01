/** Native composer proof: real Electron/CLI/kernel; only model and network I/O scripted. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? '.')
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { _electron, expect: assertions } = require('@playwright/test')
// Native process, socket and filesystem work uses Playwright's assertion timeout.
const expect = assertions.configure({ timeout: 20000 })
const root = await mkdtemp('/tmp/namzu-composer-interactions-')
const project = join(root, 'project'), home = join(root, 'namzu'), ui = join(root, 'desktop')
await mkdir(join(project, '.git'), { recursive: true }); await mkdir(home); await mkdir(ui)
await writeFile(join(project, 'namzu.config.json'), JSON.stringify({ sandbox: { enabled: false } }))
await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'anthropic', model: 'claude-sonnet-4-5' }], subagents: { active: [] } }))
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const imagePath = join(root, 'screenshot.png'), textPath = join(root, 'notes.txt'), queuePath = join(root, 'queue.txt')
await writeFile(imagePath, png); await writeFile(textPath, 'COMPOSER_TEXT_BYTES_OK\n'); await writeFile(queuePath, 'COMPOSER_QUEUED_TEXT_OK\n')
const receipts = join(root, 'requests.jsonl')
const artifacts = join(repo, 'research/runtime-desktop-20260930/artifacts')
await mkdir(artifacts, { recursive: true })
const desktop = await _electron.launch({ executablePath: require('electron'), args: [join(repo, 'packages/desktop'), `--user-data-dir=${ui}`], env: { ...process.env, NAMZU_HOME: home, ANTHROPIC_API_KEY: 'synthetic-not-a-secret', NAMZU_DESKTOP_CLI: join(repo, 'research/runtime-desktop-20260930/fixtures/scripted-cli.mjs'), NAMZU_TEST_RECEIPTS: receipts, NAMZU_TEST_COMPOSER: '1' } })
let page, closed = false
const faults = [], captures = []
const frames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const calls = () => desktop.evaluate(() => structuredClone(globalThis.__composerCalls))
const admissions = async (method) => (await calls()).filter((call) => call.method === method)
const requests = async () => (await readFile(receipts, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
async function capture(name) {
  await frames()
  // Await the real finite popup/composer animations; exclude perpetual loaders.
  // This captures a settled UI without guessing a host-speed-dependent delay.
  await page.evaluate(async () => {
    const animations = [...document.querySelectorAll('[data-slot="popover-positioner"], [data-slot="popover-popup"], [data-chat-composer-stack]')]
      .flatMap((node) => node.getAnimations({ subtree: true }))
      .filter((animation) => animation.playState !== 'finished' && animation.effect?.getComputedTiming().iterations !== Infinity && !(animation.effect?.target instanceof HTMLInputElement))
    await Promise.allSettled([...new Set(animations)].map((animation) => animation.finished))
  })
  await frames()
  await expect(page.getByRole('dialog', { name: 'Model and tool settings', exact: true })).toHaveCount(0)
  const value = await page.evaluate(() => {
    const selectors = ['[data-chat-composer-main-surface]', '[data-chat-composer-footer]', '.composer-input textarea', '.model-picker-trigger', '.model-picker-popup', '.model-search input', '[data-chat-composer-body] .attachment-list', '.attachment-preview', '[aria-label="Attach files"]', '[aria-label="Model and tool settings"]', 'button[aria-label="Plugins"]']
    return { width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, active: document.activeElement?.getAttribute('aria-label'), nodes: selectors.flatMap((selector) => [...document.querySelectorAll(selector)].map((node) => ({ selector, rect: node.getBoundingClientRect().toJSON(), font: getComputedStyle(node).font, appRegion: getComputedStyle(node).getPropertyValue('-webkit-app-region'), transition: getComputedStyle(node).transitionDuration }))) }
  })
  assert.equal(value.overflow, false)
  for (const node of value.nodes) {
    if (!node.rect.width || !node.rect.height) continue
    assert.ok(node.rect.left >= -0.1 && node.rect.right <= value.width + 0.1, `${node.selector} outside horizontal viewport`)
    assert.ok(node.rect.top >= -0.1 && node.rect.bottom <= value.height + 0.1, `${node.selector} outside vertical viewport`)
  }
  await writeFile(join(artifacts, `composer-interactions-${name}.json`), JSON.stringify(value, null, 2) + '\n')
  await page.screenshot({ path: join(artifacts, `composer-interactions-${name}.png`) })
  captures.push({ name, ...value }); return value
}
async function settings(effort, permission) {
  await page.getByRole('button', { name: 'Model and tool settings', exact: true }).click()
  if (effort) {
    await page.getByRole('combobox', { name: 'Reasoning effort', exact: true }).click()
    await page.getByRole('option', { name: effort, exact: true }).click()
  }
  if (permission) {
    await page.getByRole('combobox', { name: 'Tool permissions', exact: true }).click()
    await page.getByRole('option', { name: new RegExp(`^${permission}`) }).click()
  }
  await page.keyboard.press('Escape')
}
async function chooseFiles(paths) { await desktop.evaluate((_, paths) => { globalThis.__composerChosenFiles = paths }, paths); await page.getByRole('button', { name: 'Attach files', exact: true }).click() }
async function fileEvent(kind, name, bytes, type = 'text/plain') {
  await page.getByRole('textbox', { name: 'Message Namzu', exact: true }).evaluate((input, args) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(args.bytes)], args.name, { type: args.type }))
    if (args.kind === 'paste') input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
    else {
      const shell = input.closest('[data-chat-composer-main-surface]')
      shell.dispatchEvent(new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true, cancelable: true }))
      shell.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
    }
  }, { kind, name, bytes: [...bytes], type })
}
async function expectAnswer(count) { await expect(page.locator('.message-text').filter({ hasText: 'Composer fixture answered.' })).toHaveCount(count); await expect(page.getByRole('button', { name: 'Stop turn', exact: true })).toHaveCount(0) }
try {
  await desktop.evaluate(({ app, dialog, ipcMain }, args) => {
    app.setPath('userData', args.ui)
    globalThis.__composerChosenFiles = [args.imagePath, args.textPath]
    dialog.showOpenDialog = async (...values) => ({ canceled: false, filePaths: values.at(-1)?.properties?.includes('openFile') ? globalThis.__composerChosenFiles : [args.project] })
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    globalThis.__composerCalls = []; globalThis.__composerRejectCatalogue = true
    for (const method of ['models', 'modelSettings', 'plugins', 'newConversation', 'selectProvider', 'pickAttachments', 'addAttachments', 'removeAttachment', 'moveAttachments', 'send', 'takeQueued', 'cancel']) {
      const original = ipcMain._invokeHandlers.get(`namzu:${method}`)
      if (!original) throw new Error(`Missing actual IPC handler ${method}`)
      ipcMain.removeHandler(`namzu:${method}`)
      ipcMain.handle(`namzu:${method}`, async (event, ...values) => {
        const call = { method, values: structuredClone(values) }; globalThis.__composerCalls.push(call)
        if (method === 'models' && values[1] === 'anthropic' && globalThis.__composerRejectCatalogue) { globalThis.__composerRejectCatalogue = false; call.rejected = true; throw new Error('SYNTHETIC_SECRET_MUST_NOT_RENDER') }
        // Hold only this admission reply until the renderer observed the real failure
        // settlement. This deterministically covers settlement-before-consumption.
        const held = method === 'send' && values[1].includes('Fail composer provider once')
          ? new Promise((resolve) => { globalThis.__composerReleaseFailureReply = resolve }) : null
        const result = await original(event, ...values)
        if (held) { await held; call.replyAfterSettlement = true }
        call.result = structuredClone(result); return result
      })
    }
  }, { ui, project, imagePath, textPath })
  page = await desktop.firstWindow(); page.setDefaultTimeout(20000)
  page.on('pageerror', (error) => faults.push(error.message))
  await page.evaluate(() => { window.__composerEvents = []; window.namzu.onEvent((event) => { if (window.__composerEvents.length < 1000) window.__composerEvents.push(event) }) })
  await page.getByRole('button', { name: 'Open a project', exact: true }).last().click()
  await page.getByRole('button', { name: 'Review folder access', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'Message Namzu', exact: true })
  const model = page.getByRole('button', { name: 'Select model', exact: true })
  await expect(model).toBeEnabled()
  const ownerProject = await page.evaluate(async () => (await window.namzu.projects())[0]), owner = `project:${ownerProject.id}`
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  const inventory = await page.evaluate((id) => window.namzu.plugins(id), ownerProject.id)
  assert.deepEqual(inventory.plugins, [])
  const pluginPopup = page.getByRole('dialog', { name: 'Plugins', exact: true })
  await expect(pluginPopup).toBeVisible()
  if (inventory.notice) await expect(pluginPopup).toContainText(inventory.notice)
  await expect(pluginPopup.getByRole('button', { name: /^(Enable|Disable) / })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await model.click()
  await expect(page.getByRole('alert')).toContainText('Could not load these models. Try again.')
  await expect(page.locator('body')).not.toContainText('SYNTHETIC_SECRET_MUST_NOT_RENDER')
  await expect(page.getByText('No models listed.', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Retry Anthropic (Claude) models', exact: true }).click()
  await expect(page.getByRole('radio', { name: 'Anthropic (Claude) Fixture Opus', exact: true })).toBeVisible()
  assert.equal((await admissions('models')).filter((call) => call.values[1] === 'anthropic').length, 2)
  await page.getByRole('button', { name: 'Quick search', exact: true }).click()
  const search = page.getByRole('searchbox', { name: 'Search models', exact: true })
  await expect(search).toBeFocused()
  await page.keyboard.type('no-such-model')
  await expect(page.getByText('No matching listed models.', { exact: true })).toBeVisible()
  const providerStatus = await page.evaluate((id) => window.namzu.providers(id), ownerProject.id)
  let noticeRetry = false
  if (providerStatus.available.some((provider) => provider.id === 'zen')) {
    const before = (await admissions('models')).filter((call) => call.values[1] === 'zen').length
    await page.getByRole('button', { name: 'Retry Zen models', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Retry Zen models', exact: true })).toBeEnabled()
    assert.equal((await admissions('models')).filter((call) => call.values[1] === 'zen').length, before + 1)
    noticeRetry = true
  }
  await search.fill('Fixture Opus'); await expect(page.getByRole('radio', { name: 'Anthropic (Claude) Fixture Opus', exact: true })).toBeVisible()
  await capture('search-wide')
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('radio', { name: 'Anthropic (Claude) Fixture Opus', exact: true })).toBeFocused()
  await page.keyboard.press('Space')
  await expect(page.locator('.model-picker-popup')).not.toBeVisible(); await expect(model).toBeFocused(); await expect(model).toHaveText('Fixture Opus')
  await model.click(); await page.getByRole('button', { name: 'Quick search', exact: true }).click(); await search.fill('Fixture Sonnet'); await page.keyboard.press('Enter')
  await expect(page.locator('.model-picker-popup')).not.toBeVisible(); await expect(model).toHaveText('Fixture Sonnet')
  await model.click(); await page.getByRole('radio', { name: 'Anthropic (Claude) Fixture Opus', exact: true }).click(); await expect(page.locator('.model-picker-popup')).not.toBeVisible()
  await settings('High', 'Ask first')
  assert.equal((await admissions('newConversation')).length, 0)
  await chooseFiles([imagePath, textPath])
  const attached = page.getByRole('list', { name: 'Attached files', exact: true })
  await expect(attached.getByRole('listitem')).toHaveCount(2)
  await expect(attached.getByRole('img', { name: 'screenshot.png', exact: true })).toBeVisible()
  await expect(attached.getByRole('img', { name: 'screenshot.png', exact: true })).toHaveJSProperty('naturalWidth', 1)
  await attached.getByRole('button', { name: 'Preview screenshot.png', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('screenshot.png'); await page.getByRole('button', { name: 'Close image preview', exact: true }).click()
  await fileEvent('drop', 'dropped.txt', Buffer.from('COMPOSER_DROP_BYTES_OK'))
  await expect(attached.getByRole('listitem')).toHaveCount(3)
  await page.getByRole('button', { name: 'Remove dropped.txt', exact: true }).click(); await expect(attached.getByRole('listitem')).toHaveCount(2)
  await fileEvent('paste', 'pasted.txt', Buffer.from('COMPOSER_PASTE_BYTES_OK'))
  await expect(attached.getByRole('listitem')).toHaveCount(3)
  await page.getByRole('button', { name: 'Remove pasted.txt', exact: true }).click(); await expect(attached.getByRole('listitem')).toHaveCount(2)
  await page.reload(); await expect(attached.getByRole('listitem')).toHaveCount(2); await expect(input).toHaveValue('')
  await page.evaluate(() => { window.__composerEvents = []; window.namzu.onEvent((event) => { if (window.__composerEvents.length < 1000) window.__composerEvents.push(event) }) })
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
  await expect(model).toHaveText('Fixture Opus')
  await page.getByRole('button', { name: 'Model and tool settings', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Reasoning effort', exact: true })).toContainText('High')
  await expect(page.getByRole('combobox', { name: 'Tool permissions', exact: true })).toContainText('Ask first'); await page.keyboard.press('Escape')
  await capture('attachments-wide')
  const initial = await page.evaluate((owner) => window.namzu.attachments(owner), owner)
  assert.deepEqual(initial.map((file) => [file.name, file.kind, file.size]), [['screenshot.png', 'image', png.length], ['notes.txt', 'text', Buffer.byteLength('COMPOSER_TEXT_BYTES_OK\n')]])
  await writeFile(textPath, 'ORIGINAL_FILE_CHANGED_AFTER_CAPTURE')
  await page.getByRole('button', { name: 'Send message', exact: true }).click(); await expectAnswer(1)
  await expect(attached).toHaveCount(0)
  await expect(page.getByRole('list', { name: 'Message attachments', exact: true }).first()).toContainText('screenshot.png')
  await expect(page.getByRole('list', { name: 'Message attachments', exact: true }).first()).toContainText('notes.txt')
  const firstRequest = (await requests()).filter((request) => request.purpose === 'agent')[0]
  assert.equal(firstRequest.effort, 'high')
  assert.ok(firstRequest.users.some((message) => message.text.includes('COMPOSER_TEXT_BYTES_OK') && !message.text.includes('ORIGINAL_FILE_CHANGED_AFTER_CAPTURE')))
  assert.ok(firstRequest.users.some((message) => message.attachments.some((attachment) => attachment.type === 'image' && attachment.mediaType === 'image/png' && attachment.bytes === png.length && attachment.sha256 === createHash('sha256').update(png).digest('hex'))))
  assert.equal((await admissions('newConversation')).length, 1)
  assert.equal((await admissions('send'))[0].values[1], '')
  const session = (await admissions('newConversation'))[0].result
  assert.deepEqual(await page.evaluate((owner) => window.namzu.attachments(owner), owner), [])
  await input.fill('Hold composer turn'); await settings('High', 'Ask first'); await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Tool approval', exact: true })).toBeVisible()
  await chooseFiles([queuePath]); await expect(attached.getByRole('listitem')).toHaveCount(1)
  await input.fill('Queued attachment with captured settings'); await settings('Low', 'Plan')
  await page.getByRole('button', { name: 'Queue message', exact: true }).click()
  // Editing must restore the queued snapshot, even after current controls change.
  await settings('High', 'Ask first')
  await page.getByRole('button', { name: 'Show queued messages', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Queued messages', exact: true })).toContainText('Queued attachment with captured settings')
  await page.getByRole('button', { name: 'Edit queued message 1', exact: true }).click(); await page.keyboard.press('Escape')
  await expect(input).toHaveValue('Queued attachment with captured settings'); await expect(attached.getByRole('listitem')).toHaveCount(1)
  await page.getByRole('button', { name: 'Model and tool settings', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Reasoning effort', exact: true })).toContainText('Low')
  await expect(page.getByRole('combobox', { name: 'Tool permissions', exact: true })).toContainText('Plan'); await page.keyboard.press('Escape')
  await capture('queue-edit')
  await page.getByRole('button', { name: 'Allow once', exact: true }).click(); await expectAnswer(2)
  await page.getByRole('button', { name: 'Send message', exact: true }).click(); await expectAnswer(3)
  const queuedRequest = (await requests()).filter((request) => request.purpose === 'agent').at(-1)
  assert.equal(queuedRequest.effort, 'low'); assert.ok(queuedRequest.users.at(-1).text.includes('COMPOSER_QUEUED_TEXT_OK'))
  const actualSends = await admissions('send')
  assert.equal(actualSends.at(-1).values[2].permissionMode, 'plan')
  await input.fill('Run planned file change'); await settings('Low', 'Plan'); await page.getByRole('button', { name: 'Send message', exact: true }).click(); await expectAnswer(4)
  await assert.rejects(stat(join(project, 'composer-fixture.txt')), { code: 'ENOENT' })
  await input.fill('Run allowed file change'); await settings('High', 'Allow tools'); await page.getByRole('button', { name: 'Send message', exact: true }).click(); await expectAnswer(5)
  assert.equal(await readFile(join(project, 'composer-fixture.txt'), 'utf8'), 'COMPOSER_PERMISSION_OK')
  await expect(page.getByRole('region', { name: 'Tool approval', exact: true })).toHaveCount(0)
  await chooseFiles([imagePath]); await input.fill('Hold composer turn with retry image'); await settings('High', 'Ask first')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Tool approval', exact: true })).toBeVisible()
  const canceledRequest = (await requests()).filter((request) => request.purpose === 'agent').at(-1)
  const canceledImage = canceledRequest.users.at(-1).attachments.find((attachment) => attachment.type === 'image')
  assert.equal(canceledImage.sha256, createHash('sha256').update(png).digest('hex'))
  await page.getByRole('button', { name: 'Stop turn', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop turn', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Tool approval', exact: true })).toHaveCount(0)
  await expect(attached.getByRole('listitem')).toHaveCount(1)
  await expect(attached).toContainText('screenshot.png'); await expect(input).toHaveValue('')
  await capture('canceled-image-restored')
  await page.getByRole('button', { name: 'Send message', exact: true }).click(); await expectAnswer(6)
  const retriedImage = (await requests()).filter((request) => request.purpose === 'agent').at(-1).users.at(-1).attachments.find((attachment) => attachment.type === 'image')
  assert.deepEqual(retriedImage, canceledImage)
  await expect(attached).toHaveCount(0)
  await chooseFiles([imagePath]); await input.fill('Fail composer provider once')
  await page.evaluate((id) => {
    window.__composerFailureStates = []; window.__composerFailureEvents = []
    window.__composerFailureSettlement = new Promise((resolve) => {
      const off = window.namzu.onEvent((event) => {
        if (event.sessionId !== id) return
        window.__composerFailureEvents.push(event)
        if (event.kind !== 'state') return
        window.__composerFailureStates.push(event)
        if (!event.running) { off(); resolve(event) }
      })
    })
  }, session.id)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.evaluate(async () => { await window.__composerFailureSettlement })
  await frames()
  await expect(page.getByRole('button', { name: 'Sending', exact: true })).toBeDisabled()
  const failureStates = await page.evaluate(() => window.__composerFailureStates)
  const failureEvents = await page.evaluate(() => window.__composerFailureEvents)
  assert.ok(failureEvents.some((event) => event.kind === 'update' && event.update.kind === 'turn_ended' && event.update.stopReason === 'error' && event.update.error.includes('COMPOSER_PROVIDER_FAILURE_FOR_RETRY')), 'Actual provider failure must report the canonical error update')
  await expect(page.locator('body')).toContainText('Provider stream error: COMPOSER_PROVIDER_FAILURE_FOR_RETRY')
  await desktop.evaluate(() => globalThis.__composerReleaseFailureReply())
  await expect(page.getByRole('button', { name: 'Sending', exact: true })).toHaveCount(0)
  await expect(attached.getByRole('listitem')).toHaveCount(1)
  await expect(attached).toContainText('screenshot.png'); await expect(input).toHaveValue('')
  await capture('failed-image-restored')
  await page.getByRole('button', { name: 'Send message', exact: true }).click(); await expectAnswer(7)
  const failedRetryImage = (await requests()).filter((request) => request.purpose === 'agent').at(-1).users.at(-1).attachments.find((attachment) => attachment.type === 'image')
  assert.deepEqual(failedRetryImage, canceledImage)
  assert.ok((await admissions('send')).some((call) => call.replyAfterSettlement))
  await expect(attached).toHaveCount(0)
  await chooseFiles([imagePath]); await input.fill('A bounded composer layout draft')
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(600, 540)); await page.emulateMedia({ reducedMotion: 'reduce' })
  await capture('attachments-narrow-reduced')
  await model.click(); await page.getByRole('button', { name: 'Quick search', exact: true }).click(); await search.fill('Fixture Opus')
  await expect(search).toBeFocused(); await capture('search-narrow-reduced'); await page.keyboard.press('Escape'); await expect(model).toBeFocused()
  assert.deepEqual(faults, [])
  const result = { native: true, realCli: true, realKernel: true, modelNetworkIo: 'scripted', root, quickSearchClickAndKeyboard: true, sanitizedCatalogErrorAndRetry: true, noticeRetry, actualPluginInventoryWithoutInventedControls: true, inventory, nativeDialogByteCapture: true, dropAndPasteByteAdmission: true, previewAndRemove: true, rendererReloadRetainsFiles: true, fileOnlySendReachesRealKernel: true, imageBytesVerified: true, sourceFileMutationDoesNotChangeCapturedText: true, actualEffortSnapshot: true, queueEditRestoresFilesAndSettings: true, planRefusesActualWrite: true, allowToolsExecutesActualWrite: true, cancelRestoresImageAndRetryExactBytes: true, failureSettlesBeforeReplyAndRetryExactBytes: true, failureStates, failureEvents, settledPopupCaptures: true, narrowReducedLayout: true, noOverflow: true, sessionId: session.id, calls: await calls(), requests: await requests(), captures }
  await desktop.close(); closed = true
  await writeFile(join(artifacts, 'composer-interactions-native-receipt.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify({ complete: true, root, agentRequests: result.requests.filter((request) => request.purpose === 'agent').length }))
} catch (error) {
  if (page && !page.isClosed()) await Promise.allSettled([page.screenshot({ path: join(root, 'failure.png') }), page.evaluate(() => ({ active: document.activeElement?.getAttribute('aria-label'), text: document.body.innerText, dialogs: [...document.querySelectorAll('[role="dialog"]')].map((node) => node.outerHTML), events: window.__composerEvents })).then(async (value) => writeFile(join(root, 'failure.json'), JSON.stringify({ ...value, calls: await calls() }, null, 2)))])
  console.error(JSON.stringify({ failedProbeRoot: root })); throw error
} finally { if (!closed) await desktop.close() }
