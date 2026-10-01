/** Actual renderer motion proof: deferred CSS times, empty background-job inventory. */
import { createRequire } from 'node:module'
import { writeFile, mkdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
const repo = resolve(process.argv[2] ?? '.')
const origin = process.env.NAMZU_DESKTOP_DEV_URL ?? 'http://127.0.0.1:5173/'
const artifacts = join(repo, 'research/runtime-desktop-20260930/artifacts')
const require = createRequire(`${repo}/packages/desktop/package.json`)
const { chromium, expect } = require('@playwright/test')
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
const page = await context.newPage()
const captures = []
await mkdir(artifacts, { recursive: true })
async function measure(name) {
  const value = await page.evaluate(() => {
    const selectors = ['.workspace', '.topbar', '.chat-stage', '.jobs-panel', '.jobs-button', '.transcript', '.composer-wrap > div', '.composer-input textarea']
    const rects = Object.fromEntries(selectors.map(selector => {
      const node = document.querySelector(selector), style = getComputedStyle(node)
      return [selector, { ...node.getBoundingClientRect().toJSON(), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, transform: style.transform, visibility: style.visibility, paddingRight: style.paddingRight, paddingInlineEnd: style.paddingInlineEnd, overflow: style.overflow, bg: style.backgroundColor, transition: style.transition }]
    }))
    return { width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth, focused: { tag: document.activeElement.tagName, label: document.activeElement.getAttribute('aria-label'), inert: Boolean(document.activeElement.closest('[inert]')) }, rects, animations: document.getAnimations().map(a => ({ selector: a.effect.target.className, property: a.transitionProperty, time: a.currentTime, duration: a.effect.getTiming().duration })) }
  })
  captures.push({ name, ...value })
  await page.screenshot({ path: join(artifacts, `background-work-${name}.png`) })
}
async function pause(progress) {
  await page.evaluate(progress => {
    for (const animation of document.getAnimations()) {
      if (!animation.transitionProperty) continue
      animation.pause()
      animation.currentTime = Number(animation.effect.getTiming().duration) * progress
    }
  }, progress)
}
async function settle() {
  await page.evaluate(async () => {
    for (const animation of document.getAnimations()) {
      if (!animation.transitionProperty) continue
      animation.finish()
    }
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  })
}
try {
  await page.goto(new URL('preview', origin).href)
  await page.locator('.sidebar-project-list').getByRole('button', { name: 'Refine navigation', exact: true }).click()
  await expect(page.locator('[data-conversation-title]')).toContainText('Refine navigation')
  await page.getByRole('textbox', { name: 'Message Namzu', exact: true }).fill('A retained draft while background work opens and closes.')
  await page.evaluate(() => document.fonts.ready)
  await measure('wide-closed')
  await page.getByRole('button', { name: 'Background work', exact: true }).first().click()
  await pause(0.5)
  await measure('wide-opening-middle')
  await page.getByRole('button', { name: 'Close background work', exact: true }).click()
  await pause(0.5)
  await measure('wide-reversed-closing-middle')
  await settle()
  await measure('wide-reversed-closed')
  await page.getByRole('button', { name: 'Background work', exact: true }).first().click()
  await settle()
  await measure('wide-open')
  await page.getByRole('button', { name: 'Close background work', exact: true }).click()
  await settle()
  await page.setViewportSize({ width: 1900, height: 820 })
  await settle()
  await measure('large-context-closed')
  await page.getByRole('button', { name: 'Background work', exact: true }).first().click()
  await pause(0)
  await measure('large-context-opening-start')
  await pause(0.5)
  await measure('large-context-opening-middle')
  await page.getByRole('button', { name: 'Close background work', exact: true }).click()
  await pause(0.5)
  await measure('large-context-reversed-closing-middle')
  await settle()
  await measure('large-context-reversed-closed')
  await page.getByRole('button', { name: 'Background work', exact: true }).first().click()
  await settle()
  await measure('large-context-open')
  await page.setViewportSize({ width: 1120, height: 740 })
  await settle()
  await measure('wide-1120-open')
  await page.getByRole('button', { name: 'Close background work', exact: true }).click()
  await settle()
  await page.setViewportSize({ width: 600, height: 540 })
  await settle()
  await measure('narrow-closed')
  await page.getByRole('button', { name: 'Background work', exact: true }).first().click()
  await pause(0.5)
  await measure('narrow-opening-middle')
  await page.getByRole('button', { name: 'Close background work', exact: true }).click()
  await pause(0.5)
  await measure('narrow-reversed-closing-middle')
  await settle()
  await measure('narrow-reversed-closed')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: 'Background work', exact: true }).first().click()
  await measure('narrow-reduced-open')
  await page.getByRole('button', { name: 'Close background work', exact: true }).click()
  await measure('narrow-reduced-closed')
  await expect(page.getByRole('textbox', { name: 'Message Namzu', exact: true })).toHaveValue('A retained draft while background work opens and closes.')
  for (const capture of captures) assert.equal(capture.overflow, false, capture.name)
  const find = (name) => captures.find(capture => capture.name === name)
  for (const name of ['wide-opening-middle', 'wide-open', 'wide-reversed-closing-middle', 'large-context-opening-start', 'large-context-opening-middle', 'large-context-reversed-closing-middle', 'large-context-open']) {
    const row = find(name).rects
    assert.ok(Math.abs(row['.chat-stage'].right - row['.jobs-panel'].x) < 0.1, `${name}: split boundary stays joined`)
  }
  const overlay = find('wide-1120-open').rects
  assert.equal(overlay['.chat-stage'].width, overlay['.workspace'].width, 'actual workspace under880 uses overlay')
  const start = find('large-context-opening-start').rects, closed = find('large-context-closed').rects
  assert.equal(start['.transcript'].paddingRight, closed['.transcript'].paddingRight, 'context gutter does not jump at opening')
  assert.equal(start['.composer-wrap > div'].paddingInlineEnd, closed['.composer-wrap > div'].paddingInlineEnd, 'composer gutter does not jump at opening')
  assert.equal(find('narrow-closed').rects['.jobs-button'].x, find('narrow-reduced-open').rects['.jobs-button'].x, 'header actions do not disappear at opening')
  assert.equal(find('narrow-reduced-open').rects['.jobs-panel'].transition, 'none')
  assert.equal(find('narrow-reduced-closed').rects['.jobs-panel'].visibility, 'hidden')
  for (const name of ['wide-reversed-closed', 'large-context-reversed-closed', 'narrow-reversed-closed', 'narrow-reduced-closed']) {
    assert.equal(find(name).focused.label, 'Background work', `${name}: close restores the real opener`)
    assert.equal(find(name).focused.inert, false, `${name}: restored focus is interactive`)
  }
  await page.getByRole('button', { name: 'Show changes', exact: true }).click()
  await page.getByRole('button', { name: 'Close changes', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Show changes', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Background work', exact: true }).first().click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Background work', exact: true }).first()).toBeFocused()
  assert.equal(await page.locator('.jobs-panel').getAttribute('data-open'), 'false')
  await writeFile(join(artifacts, 'background-work-motion-receipt.json'), JSON.stringify(captures, null, 2))
  console.log(JSON.stringify({ passed: true, states: captures.length, retainedDraft: true, closeAndEscapeRestoreOpener: true, receipt: join(artifacts, 'background-work-motion-receipt.json') }))
} finally { await browser.close() }
