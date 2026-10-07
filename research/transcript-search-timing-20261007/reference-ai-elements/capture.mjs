/** Read-only, real public reference pages. No package install or product/native/model actions. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const output = dirname(fileURLToPath(import.meta.url))
const require = createRequire(resolve('packages/desktop/package.json'))
const { chromium } = require('@playwright/test')
await mkdir(output, { recursive: true })
const sourceCache = await mkdtemp(join(tmpdir(), 'namzu-reference-ai-elements-'))
const receipt = {
  at: new Date().toISOString(),
  scope: 'Read-only public primary sites, real DOM and CSS; no synthetic UI fixture',
  viewport: { width: 1440, height: 1000 }, colorScheme: 'dark', zoom: 1,
  pages: [], sources: [], faults: [],
}
const sha = '6a9d5b1822ffb10bba4bd97175f01edd7d8651cd'
receipt.sourceRevision = sha
for (const name of ['chain-of-thought', 'reasoning', 'sources', 'tool']) {
  const url = `https://raw.githubusercontent.com/vercel/ai-elements/${sha}/packages/elements/src/${name}.tsx`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Reference source unavailable: ${name}`)
  const source = await response.text()
  const file = `${name}.source.tsx`
  await writeFile(join(sourceCache, file), source)
  receipt.sources.push({ name, url, sha256: createHash('sha256').update(source).digest('hex') })
}

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: receipt.viewport, colorScheme: receipt.colorScheme })
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => receipt.faults.push({ url: page.url(), message: error.message }))
  async function navigate(url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.locator('h1').waitFor()
    await page.evaluate(() => document.fonts.ready)
  }
  const measure = async (container, label) => {
    await container.waitFor({ state: 'visible' })
    const read = () => container.evaluate((root, label) => {
    const style = element => {
      const css = getComputedStyle(element), rect = element.getBoundingClientRect()
      const fields = ['fontFamily', 'fontSize', 'lineHeight', 'fontWeight', 'letterSpacing', 'color',
        'backgroundColor', 'padding', 'gap', 'borderRadius', 'borderColor', 'overflow', 'animationName',
        'animationDuration', 'animationTimingFunction', 'transitionProperty', 'transitionDuration',
        'transitionTimingFunction', 'transform', 'opacity']
      return { tag: element.tagName, slot: element.getAttribute('data-slot'),
        text: element.textContent?.trim().slice(0, 220), state: element.getAttribute('data-state'),
        expanded: element.getAttribute('aria-expanded'), controls: element.getAttribute('aria-controls'),
        href: element.getAttribute('href'), title: element.getAttribute('title'),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        css: Object.fromEntries(fields.map(field => [field, css[field]])) }
    }
    return { label, url: location.href, text: root.innerText,
      root: style(root), html: root.outerHTML,
      rows: [...root.querySelectorAll('button,[data-slot="badge"],a,[data-slot="item-title"],[data-slot="item-description"],[data-slot="collapsible-content"]')].map(style),
      icons: [...root.querySelectorAll('svg')].map(element => ({ className: element.getAttribute('class'),
        width: getComputedStyle(element).width, height: getComputedStyle(element).height,
        hidden: element.getAttribute('aria-hidden') })),
      animations: root.getAnimations({ subtree: true }).map(animation => ({
        name: animation.animationName ?? null, playState: animation.playState, currentTime: animation.currentTime,
        timing: animation.effect?.getTiming(), keyframes: animation.effect?.getKeyframes() })),
      nestedButtons: [...root.querySelectorAll('button')].filter(button => button.querySelector('button')).length,
    }
    }, label)
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await read()
      if (row.root.rect.width > 0 && row.root.css.fontSize) return row
      // The public site's hydration can replace server nodes once; inspect the new node.
      await container.waitFor({ state: 'visible' })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    }
    throw new Error(`Reference node never attached for ${label}`)
  }
  async function shot(container, name) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await container.screenshot({ path: join(output, `${name}.png`), animations: 'disabled' })
        return
      } catch (error) {
        if (!String(error).includes('not attached to the DOM') || attempt === 2) throw error
      }
    }
  }

  await navigate('https://elements.ai-sdk.dev/components/chain-of-thought')
  const chainTrigger = page.getByRole('button', { name: 'Chain of Thought', exact: true })
  await page.getByText('Searching for profiles for Hayden Bleasel', { exact: true }).waitFor()
  const chain = chainTrigger.locator('xpath=../..')
  await shot(chain, 'chain-expanded')
  receipt.pages.push(await measure(chain, 'chain-expanded'))
  await chainTrigger.click()
  receipt.pages.push(await measure(chain, 'chain-collapse-transition'))
  await shot(chain, 'chain-collapsed')
  receipt.pages.push(await measure(chain, 'chain-collapsed'))
  await chainTrigger.focus()
  await page.keyboard.press('Enter')
  receipt.chainKeyboardReopened = await chainTrigger.getAttribute('aria-expanded') === 'true'

  await navigate('https://elements.ai-sdk.dev/components/reasoning')
  const reasoningTrigger = page.getByRole('button', { name: /^(Thinking\.\.\.|Thought for .*)$/ })
  await reasoningTrigger.waitFor()
  const reasoning = reasoningTrigger.locator('xpath=..')
  receipt.pages.push(await measure(reasoning, 'reasoning-streaming'))
  await shot(reasoning, 'reasoning-streaming')
  // This waits for the public demo's own state, not an arbitrary sleep or guessed duration.
  await page.getByRole('button', { name: /^Thought for / }).waitFor({ timeout: 60000 })
  receipt.pages.push(await measure(reasoning, 'reasoning-completed'))
  await shot(reasoning, 'reasoning-completed')
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button =>
    button.textContent.startsWith('Thought for ') && button.getAttribute('aria-expanded') === 'false'))
  await shot(reasoning, 'reasoning-completed-auto-collapsed')
  receipt.pages.push(await measure(reasoning, 'reasoning-completed-auto-collapsed'))

  await navigate('https://elements.ai-sdk.dev/components/sources')
  const sourcesTrigger = page.getByRole('button', { name: 'Used 3 sources', exact: true })
  await sourcesTrigger.waitFor()
  const sources = sourcesTrigger.locator('xpath=..')
  receipt.pages.push(await measure(sources, 'sources-collapsed'))
  await shot(sources, 'sources-collapsed')
  await sourcesTrigger.click()
  await sources.locator('a').first().waitFor()
  receipt.pages.push(await measure(sources, 'sources-expanded-transition'))
  await shot(sources, 'sources-expanded')
  receipt.pages.push(await measure(sources, 'sources-expanded'))

  await navigate('https://elements.ai-sdk.dev/components/tool')
  const tools = page.locator('[data-slot="collapsible"]').filter({ has: page.getByRole('button', { name: /^database_query\s*(Pending|Awaiting Approval|Responded|Running|Completed|Error|Denied)$/ }) })
  await tools.first().waitFor()
  receipt.toolStatusRows = await page.getByRole('button', { name: /^database_query/ }).evaluateAll(rows => rows.map(row => ({ text: row.textContent, expanded: row.getAttribute('aria-expanded') })))
  await shot(tools.first(), 'tool-pending-expanded')
  receipt.pages.push(await measure(tools.first(), 'tool-pending-expanded'))
  const completedTrigger = page.getByRole('button', { name: /^database_query\s*Completed$/ }).first()
  const completedTool = completedTrigger.locator('xpath=..')
  if (await completedTrigger.getAttribute('aria-expanded') !== 'true') await completedTrigger.click()
  await completedTool.locator('h4').first().waitFor()
  receipt.pages.push(await measure(completedTool, 'tool-completed-expanded'))
  await shot(completedTool, 'tool-completed-expanded')

  await navigate('https://ui.shadcn.com/docs/components/base/item')
  const itemPreview = page.locator('[data-slot="component-preview"]').filter({ has: page.getByText('Basic Item', { exact: true }) }).first()
  await itemPreview.waitFor()
  receipt.pages.push(await measure(itemPreview, 'shadcn-item-basic'))
  await shot(itemPreview, 'shadcn-item-basic')
  receipt.itemSizeRows = await page.locator('[data-slot="item"]').evaluateAll(rows => rows.map(row => ({ text: row.textContent, size: row.getAttribute('data-size'), variant: row.getAttribute('data-variant'), className: row.className })).filter(row => /Size|Size|compact/.test(row.text)))

  await navigate('https://ui.shadcn.com/docs/components/base/badge')
  const badgePreview = page.locator('[data-slot="component-preview"]').first()
  await badgePreview.waitFor()
  receipt.pages.push(await measure(badgePreview, 'shadcn-badge-variants'))
  await shot(badgePreview, 'shadcn-badge-variants')

  await navigate('https://ui.shadcn.com/docs/components/base/collapsible')
  const collapsePreview = page.locator('[data-slot="component-preview"]').first()
  await collapsePreview.waitFor()
  const collapseTrigger = collapsePreview.getByRole('button', { name: 'Toggle details' })
  receipt.pages.push(await measure(collapsePreview, 'shadcn-collapsible-default'))
  await collapseTrigger.click()
  receipt.pages.push(await measure(collapsePreview, 'shadcn-collapsible-transition'))
  await shot(collapsePreview, 'shadcn-collapsible-expanded')
  receipt.pages.push(await measure(collapsePreview, 'shadcn-collapsible-expanded'))
} finally {
  await browser.close()
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
console.log(JSON.stringify({ output, sourceCache, states: receipt.pages.map(row => row.label), faults: receipt.faults, sourceRevision: receipt.sourceRevision }))
