'use strict'

// Fresh native readiness observation only. No prompts, clipboard, focus, input,
// preference writes or old-layout restoration; authored values are not read.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

async function main() {
  assert.equal(process.platform, 'win32')
  assert.equal(process.argv.length, 2)
  const dev = path.join(process.env.LOCALAPPDATA, 'Namzu', 'Development')
  const configFile = path.join(dev, 'launch.json')
  const configBytes = fs.readFileSync(configFile)
  const config = JSON.parse(configBytes)
  const pidFile = path.join(dev, 'desktop.pid')
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
  assert(Number.isSafeInteger(pid) && pid > 0)
  process.kill(pid, 0)
  const port = Number(fs.readFileSync(path.join(process.env.APPDATA, 'Namzu', 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0])
  assert(Number.isInteger(port) && port > 0 && port < 65536)
  const { chromium } = require(path.join(dev, 'runtime/packages/p39'))
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 })
  try {
    const pages = browser.contexts().flatMap(context => context.pages()).filter(page => page.url() === new URL(config.url).href)
    assert.equal(pages.length, 1)
    const status = await pages[0].evaluate(async () => {
      const workspace = await window.namzu.workspace()
      const visible = node => node.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && !node.closest('[inert], [aria-hidden="true"]')
      const inputs = [...document.querySelectorAll('textarea, input')].filter(visible)
      if (inputs.length > 128) throw new Error('Read-only input inventory exceeds bound.')
      const activeWorkIndicators = Object.fromEntries(['.thread-running-indicator', '.composer-approval-strip', '.queued-messages'].map(selector => [selector, document.querySelectorAll(selector).length]))
      const rect = node => {
        const box = node.getBoundingClientRect()
        return { x: box.x, y: box.y, width: box.width, height: box.height }
      }
      return {
        observedAt: new Date().toISOString(),
        windowCount: workspace.layout.windows.length,
        pendingTransfer: Boolean(workspace.pendingTransfer || workspace.outgoingTransfer || workspace.closingWindow),
        visibleInputCount: inputs.length,
        nonemptyInputCount: inputs.filter(node => node.value.length > 0).length,
        visibleDialogCount: [...document.querySelectorAll('[role="dialog"]')].filter(visible).length,
        activeWork: Object.values(activeWorkIndicators).some(count => count > 0),
        activeWorkIndicators,
        palTranscriptVisible: [...document.querySelectorAll('.pal-chat-transcript')].some(visible),
        footerCount: document.querySelectorAll('.message-footer').length,
        clockCount: document.querySelectorAll('.message-time').length,
        footerGeometry: [...document.querySelectorAll('.message-footer')].filter(visible).slice(0, 8).map(node => ({ rect: rect(node), opacity: getComputedStyle(node).opacity })),
      }
    })
    assert.equal(Number(fs.readFileSync(pidFile, 'utf8').trim()), pid)
    assert.deepEqual(fs.readFileSync(configFile), configBytes)
    console.log(JSON.stringify({ readOnly: true, pid, launchConfigSha256: crypto.createHash('sha256').update(configBytes).digest('hex'), uiActions: 0, providerRequests: 0, nativeWrites: 0, bodyReads: 0, authoredValueReads: 0, ...status }))
  } finally {
    await browser.close()
  }
}

main().catch(error => {
  console.error(JSON.stringify({ readOnly: true, failed: true, errorType: error.name }))
  process.exitCode = 1
})
