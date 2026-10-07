'use strict'

// Existing selected conversation only. Hover a real footer, temporarily scroll
// within its current pane if needed, and restore that fresh reader position.
// Never click copy/speak, focus an editor, open another owner or write settings.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

async function main() {
  assert.equal(process.platform, 'win32')
  assert.equal(process.argv.length, 3)
  const expectedPid = Number(process.argv[2])
  assert(Number.isSafeInteger(expectedPid) && expectedPid > 0)
  const dev = path.join(process.env.LOCALAPPDATA, 'Namzu', 'Development')
  const configBytes = fs.readFileSync(path.join(dev, 'launch.json'))
  const config = JSON.parse(configBytes)
  const pid = () => Number(fs.readFileSync(path.join(dev, 'desktop.pid'), 'utf8').trim())
  assert.equal(pid(), expectedPid)
  process.kill(expectedPid, 0)
  const port = Number(fs.readFileSync(path.join(process.env.APPDATA, 'Namzu', 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0])
  assert(Number.isInteger(port) && port > 0 && port < 65536)
  const { chromium } = require(path.join(dev, 'runtime/packages/p39'))
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 })
  const monitorKey = `namzuFooterProof:${crypto.randomUUID()}`
  let readerPage, readerBaseline, readerRestored = false
  const restoreReader = () => readerPage.evaluate(async ({ original, key }) => {
    const monitor = window[key]
    if (!monitor || monitor.events !== 0 || JSON.stringify(await window.namzu.workspace()) !== JSON.stringify(original.workspace)) throw new Error('Human input or workspace changed; no old reader position may be restored.')
    const pane = [...document.querySelectorAll('[data-workspace-group]')].find(node => node.dataset.workspaceGroup === original.groupId)
    const transcript = pane.querySelector('.transcript')
    transcript.scrollTo({ top: original.scrollTop, behavior: 'instant' })
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    if (transcript.scrollTop !== original.scrollTop) throw new Error('The fresh reader position was not restored.')
  }, { original: readerBaseline, key: monitorKey })
  try {
    const pages = browser.contexts().flatMap(context => context.pages()).filter(page => page.url() === new URL(config.url).href)
    assert.equal(pages.length, 1)
    const page = pages[0]
    readerPage = page
    await page.evaluate(key => {
      if (Object.hasOwn(window, key)) throw new Error('A footer observer key is already in use.')
      const monitor = { events: 0, handler: null }
      monitor.handler = () => { monitor.events++ }
      for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(event, monitor.handler, { capture: true, passive: true })
      window[key] = monitor
    }, monitorKey)
    await page.mouse.move(4, 4)
    const initial = await page.evaluate(async () => {
      const workspace = await window.namzu.workspace()
      const win = workspace.layout.windows.find(window => window.id === workspace.windowId)
      const pane = [...document.querySelectorAll('[data-workspace-group]')].find(node => node.dataset.workspaceGroup === win.focusedGroupId)
      const transcript = pane?.querySelector('.transcript')
      if (!transcript) throw new Error('The current conversation reader is unavailable.')
      return { workspace, groupId: win.focusedGroupId, scrollTop: transcript.scrollTop }
    })
    readerBaseline = initial
    let temporaryScrolls = 0
    await page.evaluate(async ({ original, key }) => {
      if (window[key]?.events !== 0 || JSON.stringify(await window.namzu.workspace()) !== JSON.stringify(original.workspace)) throw new Error('Human input or workspace changed; no scroll is permitted.')
      const pane = [...document.querySelectorAll('[data-workspace-group]')].find(node => node.dataset.workspaceGroup === original.groupId)
      const footer = [...pane.querySelectorAll('.message.assistant > .message-footer, .pal-chat-message.assistant > .message-footer')].find(node => node.querySelector('.message-time') && node.querySelector('.message-copy-button'))
      if (!footer) throw new Error('No existing settled reply footer is available.')
      footer.scrollIntoView({ block: 'center', behavior: 'instant' })
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    }, { original: initial, key: monitorKey })
    temporaryScrolls++
    const observe = () => page.evaluate(async () => {
      const workspace = await window.namzu.workspace()
      const visible = node => node.checkVisibility({ opacityProperty: false, visibilityProperty: true }) && !node.closest('[inert], [aria-hidden="true"]')
      const messages = [...document.querySelectorAll('.message.assistant, .pal-chat-message.assistant')].filter(visible)
      const node = messages.find(message => {
        const footer = message.querySelector(':scope > .message-footer')
        if (!footer || !footer.querySelector('.message-time') || !footer.querySelector('.message-copy-button')) return false
        const box = footer.getBoundingClientRect()
        return box.width > 0 && box.top >= 0 && box.bottom <= innerHeight
      })
      if (!node) throw new Error('A visible existing reply footer is unavailable; no owner navigation is permitted.')
      const footer = node.querySelector(':scope > .message-footer')
      await Promise.all(footer.getAnimations().map(animation => animation.finished.catch(() => {})))
      const rect = element => {
        const box = element.getBoundingClientRect()
        return { x: box.x, y: box.y, width: box.width, height: box.height, centerY: box.y + box.height / 2 }
      }
      const transcript = node.closest('.transcript')
      return {
        workspace,
        replyIndex: messages.indexOf(node),
        focusedElement: document.activeElement?.tagName ?? null,
        copyBridgeAvailable: typeof window.namzu.copyText === 'function',
        nonemptyVisibleInputs: [...document.querySelectorAll('textarea,input')].filter(visible).filter(input => input.value.length > 0).length,
        geometry: {
          message: rect(node), footer: rect(footer), clock: rect(footer.querySelector('.message-time')),
          voice: footer.querySelector('.local-speech-read-aloud') ? rect(footer.querySelector('.local-speech-read-aloud')) : null,
          copy: rect(footer.querySelector('.message-copy-button')),
          scrollTop: transcript.scrollTop, scrollHeight: transcript.scrollHeight,
        },
        opacity: getComputedStyle(footer).opacity,
      }
    })
    const before = await observe()
    assert(before.copyBridgeAvailable)
    assert.equal(before.nonemptyVisibleInputs, 0)
    assert.equal(before.opacity, '0')
    await page.mouse.move(before.geometry.footer.x + 2, before.geometry.footer.centerY)
    const hovered = await observe()
    assert.equal(hovered.replyIndex, before.replyIndex)
    assert.deepEqual(hovered.workspace, before.workspace)
    assert.equal(hovered.focusedElement, before.focusedElement)
    assert.deepEqual(hovered.geometry, before.geometry)
    assert.equal(hovered.opacity, '1')
    const center = hovered.geometry.clock.centerY
    assert(Math.abs(hovered.geometry.copy.centerY - center) <= 0.51)
    if (hovered.geometry.voice) assert(Math.abs(hovered.geometry.voice.centerY - center) <= 0.51)
    const captureName = `native-footer-${expectedPid}-${crypto.randomUUID()}.png`
    const captureFile = path.join(__dirname, 'artifacts', captureName)
    assert(!fs.existsSync(captureFile))
    const { x, y, width, height } = hovered.geometry.footer
    const capture = await page.screenshot({ clip: { x, y, width, height } })
    fs.writeFileSync(captureFile, capture, { flag: 'wx' })
    await page.mouse.move(4, 4)
    const after = await observe()
    assert.deepEqual(after.workspace, before.workspace)
    assert.equal(after.focusedElement, before.focusedElement)
    assert.deepEqual(after.geometry, before.geometry)
    assert.equal(after.opacity, before.opacity)
    await restoreReader()
    readerRestored = true
    temporaryScrolls++
    assert.equal(pid(), expectedPid)
    assert.deepEqual(fs.readFileSync(path.join(dev, 'launch.json')), configBytes)
    console.log(JSON.stringify({ passed: true, pid: expectedPid, observedAt: new Date().toISOString(), source: 'Existing native selected conversation', activeOwnerAndLayoutPreserved: true, focusPreserved: true, freshReaderPositionRestored: true, temporaryScrolls, clipboardWrites: 0, speechActions: 0, providerRequests: 0, bodyReads: 0, pointerMoves: 3, copyBridgeAvailable: true, capture: captureName, captureSha256: crypto.createHash('sha256').update(capture).digest('hex'), workspaceSha256: crypto.createHash('sha256').update(JSON.stringify(before.workspace)).digest('hex'), idleOpacity: before.opacity, hoverOpacity: hovered.opacity, leaveOpacity: after.opacity, geometry: hovered.geometry }))
  } finally {
    if (readerBaseline && !readerRestored) {
      try { await restoreReader() } catch { /* Human changes retain precedence. */ }
    }
    if (readerPage) await readerPage.evaluate(key => {
      const monitor = window[key]
      if (!monitor) return
      for (const event of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.removeEventListener(event, monitor.handler, true)
      delete window[key]
    }, monitorKey).catch(() => {})
    await browser.close()
  }
}

main().catch(error => {
  console.error(JSON.stringify({ passed: false, errorType: error.name, reason: error.message.split('\n')[0], clipboardWrites: 0, speechActions: 0, providerRequests: 0, bodyReads: 0 }))
  process.exitCode = 1
})
