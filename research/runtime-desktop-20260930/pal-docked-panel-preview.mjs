/** Live renderer proof with explicit memory fixtures, no model or guest execution. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
const repo = resolve(process.argv[2] ?? '.')
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { chromium, expect: checks } = require('@playwright/test')
const expect = checks.configure({ timeout: 20000 })
const out = join(repo, 'research/runtime-desktop-20260930/artifacts')
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1322, height: 900 } })
const faults = [], states = []
page.on('pageerror', (error) => faults.push(error.message))
const panel = () => page.getByRole('complementary', { name: 'Pal context', exact: true })
const sidebar = () => page.getByRole('complementary', { name: 'Projects and conversations', exact: true })
async function capture(name) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity && !(animation.effect?.target instanceof HTMLInputElement)).map(animation => animation.finished))
  })
  const geometry = await page.evaluate(() => {
    const bounds = selector => document.querySelector(selector)?.getBoundingClientRect().toJSON()
    return { viewport: [innerWidth, innerHeight], panel: bounds('.pal-context-card'), lane: bounds('.conversation-lane'), composer: bounds('.composer-wrap'), stage: bounds('.chat-stage'), avatar: bounds('.pal-context-avatar .pal-character-scene'), overflow: document.documentElement.scrollWidth > innerWidth, ready: !!document.querySelector('.pal-context-avatar .pal-character-scene[data-ready]'), centered: !!document.querySelector('.pal-welcome-identity'), reduced: matchMedia('(prefers-reduced-motion: reduce)').matches }
  })
  assert.equal(geometry.overflow, false)
  assert.equal(geometry.centered, false)
  assert.ok(geometry.panel.width >= 240)
  assert.ok(geometry.composer.x + geometry.composer.width <= geometry.lane.x + geometry.lane.width + 1)
  if (geometry.stage.width >= 720) {
    assert.ok(geometry.panel.x >= geometry.lane.x + geometry.lane.width)
    assert.ok(geometry.panel.x + geometry.panel.width <= geometry.stage.x + geometry.stage.width)
  } else {
    assert.ok(geometry.panel.y + geometry.panel.height <= geometry.lane.y + 1)
  }
  await page.screenshot({ path: join(out, `pal-docked-${name}.png`) })
  states.push({ name, ...geometry })
}
try {
  await page.goto('http://127.0.0.1:5173/preview')
  await sidebar().getByRole('button', { name: 'Create your first Pal', exact: true }).click()
  await expect(page.locator('.pal-welcome-identity .pal-character-scene')).toHaveAttribute('data-ready', 'true')
  await page.locator('.pal-welcome').getByRole('button', { name: 'Customize your Pal', exact: true }).click()
  const modal = page.getByRole('dialog', { name: 'Customize your Pal', exact: true })
  await modal.getByRole('textbox', { name: 'Pal name', exact: true }).fill('Gandalf')
  await modal.getByRole('radio', { name: 'Green', exact: true }).check()
  await modal.getByRole('radio', { name: 'Pixel', exact: true }).check()
  await modal.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(modal).toHaveCount(0)
  await expect(panel()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pal context', exact: true })).toHaveCount(0)
  await expect(page.locator('.pal-welcome-identity')).toHaveCount(0)
  await expect(panel().locator('.pal-character-scene-avatar')).toHaveAttribute('data-ready', 'true')
  await expect(panel().getByRole('button', { name: 'Customize Gandalf', exact: true }).locator('svg.lucide-pencil')).toHaveCount(1)
  await capture('desktop-dark')
  // Editing is the single avatar action and preserves the always-visible dock.
  await panel().getByRole('button', { name: 'Customize Gandalf', exact: true }).click()
  await expect(modal.getByRole('textbox', { name: 'Pal name', exact: true })).toHaveValue('Gandalf')
  await modal.getByRole('radio', { name: 'Spark', exact: true }).check()
  await modal.getByRole('radio', { name: 'Violet', exact: true }).check()
  await modal.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(modal).toHaveCount(0)
  await expect(panel().locator('.pal-character-scene-avatar')).toHaveAttribute('data-ready', 'true')
  await panel().getByRole('button', { name: 'Pause Pal', exact: true }).click()
  await expect(panel().locator('.pal-character-scene-avatar')).toHaveAttribute('data-paused', 'true')
  await expect(panel().getByRole('button', { name: 'Resume Pal', exact: true })).toBeVisible()
  await capture('paused')
  await panel().getByRole('button', { name: 'Resume Pal', exact: true }).click()
  await expect(panel().locator('.pal-character-scene-avatar')).not.toHaveAttribute('data-paused', 'true')
  // External GPU loss releases the scene rather than leaving an invisible identity.
  await panel().locator('canvas').evaluate(canvas => new Promise(resolve => {
    canvas.addEventListener('webglcontextlost', () => resolve(true), { once: true })
    canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext()
  }))
  await expect(panel().locator('canvas')).toHaveCount(0)
  await expect(panel().locator('.pal-character-fallback')).toBeVisible()
  await capture('context-loss')
  await page.setViewportSize({ width: 1100, height: 760 })
  await capture('laptop')
  await page.setViewportSize({ width: 620, height: 720 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(panel()).toBeVisible()
  await capture('narrow-dark-reduced')
  await page.evaluate(() => document.documentElement.classList.remove('dark'))
  await capture('narrow-light-reduced')
  assert.deepEqual(faults, [])
  await writeFile(join(out, 'pal-docked-panel-preview-20261002.json'), JSON.stringify({ browserPreview: true, memoryFixture: true, modelRequests: 0, guestExecutions: 0, checks: ['persistent dock without trigger', 'central identity only before profile creation', 'live WebGL avatar', 'pencil edit', 'appearance save', 'pause and resume rendering', 'GPU loss releases resources and keeps fallback', 'desktop and narrow geometry', 'composer inside conversation lane', 'dark/light reduced motion'], faults, states }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, states: states.map(state => state.name), faults }))
} catch (error) {
  await page.screenshot({ path: '/var/tmp/namzu-pal-docked-failure-20261002.png' })
  console.error(JSON.stringify({ body: await page.locator('body').innerText(), faults }))
  throw error
} finally { await browser.close() }
