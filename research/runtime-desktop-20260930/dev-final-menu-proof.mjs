/** Final renderer-only proof. The prior receipt owns native navigation and CSS HMR. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? '.')
const origin = process.env.NAMZU_DESKTOP_DEV_URL ?? 'http://127.0.0.1:5173/'
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { chromium, expect: assertions } = require('@playwright/test')
const expect = assertions.configure({ timeout: 20000 })
const artifacts = join(repo, 'research/runtime-desktop-20260930/artifacts')
const root = await mkdtemp('/tmp/namzu-dev-final-menu-')
await mkdir(artifacts, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
await context.route('**/*', (route) => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort())
const page = await context.newPage()
page.setDefaultTimeout(20000)
const faults = [], captures = []
page.on('pageerror', (error) => faults.push(error.message))
const picker = () => page.getByRole('button', { name: 'Select model', exact: true })
const modelSearch = () => page.getByRole('searchbox', { name: 'Search models', exact: true })
async function selectAppearance(mode) {
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: 'Profile', exact: true }).click()
  const choice = page.getByRole('menuitemradio', { name: mode, exact: true })
  await expect(choice).toBeVisible()
  await choice.click()
  await expect(choice).toHaveCount(0)
}
async function capture(name, { reduced = false, popup = true, custom = false } = {}) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.allSettled(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity && !(animation.effect?.target instanceof HTMLInputElement)).map((animation) => animation.finished))
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  })
  const geometry = await page.evaluate(() => {
    const rect = (node) => node?.getBoundingClientRect().toJSON()
    const band = document.querySelector('[data-brand-dither]')
    const popup = document.querySelector('.model-picker-popup')
    const sidebarStyle = getComputedStyle(document.querySelector('.sidebar'))
    const xs = [...(band?.querySelector('path')?.getAttribute('d') ?? '').matchAll(/M(\d+) (\d+)h2v2h-2z/g)].map((match) => Number(match[1]))
    return {
      width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      band: { rect: rect(band), parent: rect(band.parentElement), visibility: getComputedStyle(band).visibility, pointerEvents: getComputedStyle(band).pointerEvents, animation: getComputedStyle(band).animationName, ariaHidden: band.getAttribute('aria-hidden'), viewBox: band.getAttribute('viewBox'), pixelCount: xs.length, lastPixel: Math.max(...xs) },
      wordmark: { rect: rect(document.querySelector('.sidebar .namzu-wordmark')), size: getComputedStyle(document.querySelector('.sidebar .namzu-wordmark')).fontSize },
      sidebar: { radius: sidebarStyle.borderRadius, overflow: sidebarStyle.overflow },
      popup: popup && { rect: rect(popup), side: popup.getAttribute('data-side'), align: popup.getAttribute('data-align'), overflow: popup.scrollWidth > popup.clientWidth, insideSidebar: !!popup.closest('.sidebar') },
      rail: rect(document.querySelector('.model-provider-list')),
      trigger: rect(document.querySelector('.model-picker-trigger')),
      rows: [...document.querySelectorAll('.model-picker-row')].map((node) => ({ label: node.getAttribute('aria-label'), rect: rect(node), checked: node.getAttribute('aria-checked'), glyphCount: node.querySelectorAll('.model-provider-mark').length })),
      feedback: rect(document.querySelector('.model-picker-feedback')),
      custom: rect(document.querySelector('.model-custom')),
      customInput: rect(document.querySelector('#custom-model')),
      folders: [...document.querySelectorAll('.sidebar-project-group')].map((node) => ({ id: node.getAttribute('data-project-group'), open: node.hasAttribute('data-open'), icons: [...node.querySelectorAll('.sidebar-project-folder > svg')].map((icon) => ({ class: icon.getAttribute('class'), rect: rect(icon), opacity: getComputedStyle(icon).opacity, transition: getComputedStyle(icon).transitionDuration })) })),
    }
  })
  assert.equal(geometry.overflow, false)
  assert.equal(geometry.reduced, reduced)
  assert.equal(geometry.band.rect.x, geometry.band.parent.x)
  assert.equal(geometry.band.rect.y, geometry.band.parent.y)
  assert.equal(geometry.band.rect.height, 52)
  assert.equal(geometry.band.rect.right, geometry.band.parent.right)
  assert.equal(geometry.band.pointerEvents, 'none')
  assert.equal(geometry.band.ariaHidden, 'true')
  assert.ok(geometry.band.lastPixel >= Number(geometry.band.viewBox.split(' ')[2]) - 8)
  assert.equal(geometry.wordmark.size, '9.5px')
  assert.equal(geometry.sidebar.radius, '16px 0px 0px 16px')
  assert.equal(geometry.sidebar.overflow, 'hidden')
  for (const folder of geometry.folders) {
    const openIcon = folder.icons.find((icon) => icon.class.includes('sidebar-project-folder-open'))
    const closedIcon = folder.icons.find((icon) => icon.class.includes('sidebar-project-folder-closed'))
    assert.ok(openIcon.class.includes('lucide-folder-open'))
    assert.ok(closedIcon.class.includes('lucide-folder-closed'))
    assert.equal(openIcon.opacity, folder.open ? '1' : '0')
    assert.equal(closedIcon.opacity, folder.open ? '0' : '1')
    if (reduced) {
      assert.equal(openIcon.transition, '0s')
      assert.equal(closedIcon.transition, '0s')
    }
  }
  if (reduced) assert.equal(geometry.band.animation, 'none')
  if (popup) {
    assert.ok(geometry.popup)
    assert.equal(geometry.popup.side, 'top')
    assert.equal(geometry.popup.align, 'start')
    assert.equal(geometry.rail.width, 44)
    assert.equal(geometry.popup.overflow, false)
    assert.equal(geometry.popup.insideSidebar, false)
    assert.ok(geometry.popup.rect.x >= 0 && geometry.popup.rect.right <= geometry.width)
    assert.ok(geometry.popup.rect.y >= 0 && geometry.popup.rect.bottom <= geometry.height)
    assert.ok(geometry.custom.y >= geometry.popup.rect.y && geometry.custom.bottom <= geometry.popup.rect.bottom)
    assert.ok(geometry.rows.every((row) => row.glyphCount === 0))
    if (custom) assert.ok(geometry.customInput.y >= geometry.popup.rect.y && geometry.customInput.bottom <= geometry.popup.rect.bottom)
  }
  await writeFile(join(artifacts, `dev-final-${name}.json`), JSON.stringify(geometry, null, 2) + '\n')
  await page.screenshot({ path: join(artifacts, `dev-final-${name}.png`) })
  captures.push({ name, ...geometry })
}
try {
  await page.goto(new URL('preview', origin).href)
  await expect(page.getByRole('status', { name: 'Design preview', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'What would you like to work on?', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'Message Namzu', exact: true }).fill('Final renderer review draft')
  await page.getByRole('button', { name: 'Collapse Sample app conversations', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Expand Sample app conversations', exact: true })).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('textbox', { name: 'Message Namzu', exact: true })).toHaveValue('Final renderer review draft')
  await page.getByRole('button', { name: 'Expand Sample app conversations', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Collapse Sample app conversations', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await page.evaluate(() => {
    const original = window.namzu.models.bind(window.namzu)
    window.__finalMenuCalls = []
    let rejected = false
    window.namzu.models = async (...args) => {
      window.__finalMenuCalls.push(args[1])
      if (args[1] === 'sample-local' && !rejected) {
        rejected = true
        throw new Error('CONTROLLED_CATALOGUE_FAILURE_PRIVATE')
      }
      return original(...args)
    }
  })
  await picker().click()
  await expect(page.getByRole('radio', { name: 'Sample provider Sample balanced', exact: true })).toBeVisible()
  await expect(page.locator('.model-picker-row')).toHaveCount(3)
  await expect(page.locator('.model-picker-row small')).toHaveCount(0)
  await expect(page.locator('.model-picker-shared-note')).toHaveCount(1)
  await capture('menu-wide-dark')
  await page.getByRole('button', { name: 'Quick search', exact: true }).click()
  await expect(modelSearch()).toBeFocused()
  await expect(page.getByRole('alert')).toContainText('Sample local models: Could not load these models. Try again.')
  await expect(page.locator('body')).not.toContainText('CONTROLLED_CATALOGUE_FAILURE_PRIVATE')
  await capture('search-error-wide-dark')
  await page.getByRole('button', { name: 'Retry Sample local models models', exact: true }).click()
  await expect(page.getByRole('radio', { name: 'Sample local models Sample focused', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await modelSearch().fill('no-matching-final-model')
  await expect(page.locator('.model-picker-row')).toHaveCount(0)
  await expect(page.locator('.model-picker-list')).toContainText('No matching listed models.')
  await modelSearch().fill('focused')
  await expect(page.locator('.model-picker-row')).toHaveCount(2)
  await modelSearch().press('ArrowDown')
  await expect(page.getByRole('radio', { name: 'Sample provider Sample focused', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('.model-picker-popup')).toHaveCount(0)
  await expect(picker()).toContainText('Sample focused')
  await expect(picker()).toBeFocused()
  await selectAppearance('Light')
  await picker().click()
  await expect(page.getByRole('radio', { name: 'Sample provider Sample focused', exact: true })).toBeVisible()
  await capture('menu-wide-light')
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 600, height: 540 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: 'Spaces', exact: true }).click()
  await expect(page.locator('.sidebar')).toBeVisible()
  await capture('brand-narrow-light-reduced', { reduced: true, popup: false })
  await page.mouse.click(575, 300)
  await expect(page.locator('.sidebar')).not.toBeVisible()
  await picker().click()
  await expect(page.getByRole('radio', { name: 'Sample provider Sample focused', exact: true })).toBeVisible()
  await capture('menu-narrow-light-reduced', { reduced: true })
  await page.getByRole('button', { name: 'Quick search', exact: true }).click()
  await modelSearch().fill('quick')
  await expect(page.locator('.model-picker-row')).toHaveCount(2)
  await capture('search-narrow-light-reduced', { reduced: true })
  await page.getByRole('button', { name: 'Close model search', exact: true }).click()
  await page.getByRole('button', { name: 'Use a model ID…', exact: true }).click()
  await page.getByRole('textbox', { name: 'Model', exact: true }).fill('sample-custom-review')
  await expect(page.getByRole('button', { name: 'Use model', exact: true })).toBeVisible()
  await capture('custom-narrow-light-reduced', { reduced: true, custom: true })
  await page.getByRole('textbox', { name: 'Model', exact: true }).press('Enter')
  await expect(page.locator('.model-picker-popup')).toHaveCount(0)
  await expect(picker()).toContainText('sample-custom-review')
  await selectAppearance('System')
  await selectAppearance('Dark')
  await picker().click()
  await expect(page.getByRole('radio', { name: 'Sample provider Sample balanced', exact: true })).toBeVisible()
  await capture('menu-narrow-dark-reduced', { reduced: true })
  assert.deepEqual(faults, [])
  const receipt = { rendererOnly: true, previewSampleApiOnly: true, nativeModelRequests: 0, noOverflow: true, priorBroaderProof: 'dev-preview-native-receipt.json owns native grouped navigation, drafts and real CSS HMR before final renderer-only menu/band refinements', finalRendererProof: 'Current frozen ModelPicker/CSS, full sidebar-brand-row BrandDither, rounded sidebar corners and animated folder state', sanitizedErrorRetry: true, quickSearchKeyboardAndCustom: true, folderTogglePreservesDraft: true, captures }
  await writeFile(join(artifacts, 'dev-final-menu-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ complete: true, root, captures: captures.length, modelRequests: 0 }))
} catch (error) {
  await Promise.allSettled([page.screenshot({ path: join(root, 'failure.png') }), page.evaluate(() => document.body.innerText).then((text) => writeFile(join(root, 'failure.txt'), text))])
  console.error(JSON.stringify({ failedProbeRoot: root })); throw error
} finally {
  await browser.close()
}
