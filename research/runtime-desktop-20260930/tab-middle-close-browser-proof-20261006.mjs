/** Real Chromium pointer events against the Vite renderer components and sample-only preview. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? '.')
const origin = process.env.NAMZU_DESKTOP_DEV_URL ?? 'http://127.0.0.1:5173/preview'
const artifacts = join(repo, 'research/runtime-desktop-20260930/artifacts')
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { chromium, expect } = require('@playwright/test')
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 850 } })
const page = await context.newPage()
page.setDefaultTimeout(12000)
const faults = []
page.on('pageerror', (error) => faults.push(error.message))
await context.route('**/*', (route) =>
	new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort(),
)
await mkdir(artifacts, { recursive: true })
const receipt = {
	passed: false,
	realChromiumPointerEvents: true,
	isolatedSampleOnlyRenderer: true,
	nativeActions: 0,
	modelRequests: 0,
	computerActions: 0,
	checks: [],
}
const actions = () => page.evaluate(() => structuredClone(window.__middleProof.actions))
const nonFocusActions = async () => (await actions()).filter((action) => !action.startsWith('focus:'))
const reset = () => page.evaluate(() => {
	window.__middleProof.actions.length = 0
	window.__middleProof.dragStarts = 0
})
const middle = async (locator, preserveFocus = true) => {
	await locator.scrollIntoViewIfNeeded()
	await page.locator('#proof-focus').focus()
	await locator.click({ button: 'middle' })
	if (preserveFocus) await expect(page.locator('#proof-focus')).toBeFocused()
}

try {
	await page.goto(origin, { waitUntil: 'networkidle' })
	await page.getByRole('status', { name: 'Design preview', exact: true }).waitFor()
	await page.evaluate(async () => {
		const React = (await import('/node_modules/.vite/deps/react.js')).default
		const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
		const { ConversationTabs } = await import('/src/renderer/conversation-tabs.tsx')
		const { WorkspaceCanvas } = await import('/src/renderer/workspace-canvas.tsx')
		const h = React.createElement
		const actions = []
		const leftTabs = [
			{ id: 'left-one', projectId: 'sample-app', title: 'Left one', updatedAt: '' },
			{ id: 'left-two', projectId: 'sample-app', title: 'Left two', updatedAt: '' },
			{ id: 'pal-chat', projectId: 'sample-app', title: 'Pal chat', updatedAt: '', palId: 'sample-pal' },
		]
		const rightTabs = [
			{ id: 'right-one', projectId: 'sample-docs', title: 'Right one', updatedAt: '' },
			{ id: 'right-two', projectId: 'sample-docs', title: 'Right two', updatedAt: '' },
		]
		const windowLayout = {
			id: 'proof-window',
			focusedGroupId: 'right',
			root: {
				kind: 'split', id: 'proof-split', direction: 'horizontal', ratio: 0.5,
				first: { kind: 'group', id: 'left', tabs: leftTabs.map((tab) => tab.id), activeTabId: 'pal-chat' },
				second: { kind: 'group', id: 'right', tabs: rightTabs.map((tab) => tab.id), activeTabId: 'right-one' },
			},
		}
		const proof = { actions, dragStarts: 0, setBusy: () => {} }
		window.__middleProof = proof
		const host = document.createElement('div')
		host.id = 'middle-fixture'
		host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:white;'
		document.body.append(host)
		host.addEventListener('dragstart', () => { proof.dragStarts++ })
		function Fixture() {
			const [busy, setBusy] = React.useState(false)
			proof.setBusy = setBusy
			const palWorkspace = {
				conversationId: 'pal-chat', idPrefix: 'proof-pal', palName: 'Sample Pal',
				activeTab: 'computer', computerTabOpen: true,
				onOpenChat: () => actions.push('open-chat'),
				onOpenComputer: () => actions.push('open-computer'),
				onCloseComputer: () => actions.push('close-computer'),
				onToggleProfile: () => actions.push('profile'),
			}
			return h('div', { style: { width: '1100px', height: '700px' } },
				h('button', { id: 'proof-focus', type: 'button' }, 'Unrelated focus'),
				h(WorkspaceCanvas, {
					windowLayout,
					onPaneFocus: (id) => actions.push(`focus:${id}`),
					onAction: (action) => actions.push(`workspace:${action.kind}`),
					renderPane: (group) => h('div', { className: 'workspace' }, h(ConversationTabs, {
						tabs: group.id === 'left' ? leftTabs : rightTabs,
						windowId: 'proof-window', groupId: group.id, active: group.activeTabId,
						busy, running: () => false,
						palWorkspace: group.id === 'left' ? palWorkspace : undefined,
						palNames: { 'sample-pal': 'Sample Pal' },
						onSelect: (view) => actions.push(`select:${view.id}`),
						onClose: (view) => actions.push(`close:${view.id}`),
						onNew: () => actions.push('new'),
						onDetach: (view) => actions.push(`detach:${view.id}`),
					})),
				}),
			)
		}
		createRoot(host).render(h(Fixture))
	})
	const left = page.locator('[data-workspace-group="left"]')
	const normal = left.getByRole('tab', { name: 'Namzu: Left one', exact: true })
	const pal = left.getByRole('tab', { name: 'Sample Pal', exact: true })
	const computer = left.getByRole('tab', { name: 'Sample Pal’s computer', exact: true })
	await normal.waitFor()
	await reset()
	await middle(normal)
	assert.deepEqual(await actions(), ['close:left-one'])
	assert.equal(await page.evaluate(() => window.__middleProof.dragStarts), 0)
	receipt.checks.push('middle release closes an inactive ordinary tab once without selection, drag, pane focus, or focus theft')
	await reset()
	await middle(pal)
	assert.deepEqual(await actions(), ['close:pal-chat'])
	receipt.checks.push('middle release on the Pal chat tab uses the conversation view close callback')
	await reset()
	await middle(computer)
	assert.deepEqual(await actions(), ['close-computer'])
	receipt.checks.push('middle release on the computer tab uses view-only close, without computer controls')
	await reset()
	await middle(left.getByRole('button', { name: 'Close tab Left one', exact: true }), false)
	await middle(left.getByRole('button', { name: 'Close computer tab', exact: true }), false)
	await middle(left.getByRole('button', { name: 'Show Sample Pal profile', exact: true }), false)
	await middle(left.getByRole('button', { name: 'Actions for Left one', exact: true }), false)
	assert.deepEqual((await actions()).filter((action) => action.startsWith('close')), [])
	receipt.checks.push('nested close, profile, and menu actions never middle-close their parent tab')
	await reset()
	await normal.click({ button: 'right' })
	assert.deepEqual(await nonFocusActions(), [])
	await normal.click()
	assert.deepEqual(await nonFocusActions(), ['select:left-one'])
	await reset()
	await left.getByRole('button', { name: 'Close tab Left one', exact: true }).click()
	assert.deepEqual(await nonFocusActions(), ['close:left-one'])
	receipt.checks.push('right click remains inert; primary selection and X close retain their callbacks')
	await reset()
	await page.evaluate(() => window.__middleProof.setBusy(true))
	await expect(normal).toBeDisabled()
	await expect(computer).toBeDisabled()
	await reset()
	for (const tab of [normal, computer]) {
		const box = await tab.boundingBox()
		assert.ok(box)
		await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'middle' })
	}
	assert.deepEqual(await nonFocusActions(), [])
	receipt.checks.push('busy owner disables middle close for ordinary and computer tabs')
	assert.deepEqual(faults, [])
	receipt.passed = true
} finally {
	await writeFile(join(artifacts, 'tab-middle-close-browser-proof-20261006.json'), `${JSON.stringify(receipt, null, 2)}\n`)
	await browser.close()
}
assert.equal(receipt.passed, true)
console.log(JSON.stringify(receipt))
