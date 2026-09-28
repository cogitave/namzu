import { afterEach, expect, it, vi } from 'vitest'
import { ProviderSetup } from '../ProviderSetup.js'
import { type Screen, renderToScreen } from './support/screen.js'
import { installHarness, probeHarnesses } from '../../integrations/providers/setup.js'

vi.mock('../../integrations/providers/discover.js', () => ({
	discoverProviders: vi.fn(async () => []),
}))
vi.mock('../../integrations/providers/setup.js', () => ({
	probeHarnesses: vi.fn(async () => [
		{
			harness: { id: 'opencode', label: 'OpenCode', npmPackage: 'opencode-ai' },
			installed: false,
			version: '',
			access: 'Zen free models · experimental; OpenCode installation recommended; gateway may refuse',
		},
	]),
	installHarness: vi.fn(async () => ({ code: 0, output: 'installed' })),
}))
let screen: Screen | undefined
afterEach(async () => {
	await screen?.unmount()
	vi.clearAllMocks()
})
it('requires a separate confirmation, rechecks installation and keeps connection separate', async () => {
	const connect = vi.fn()
	screen = await renderToScreen(
		<ProviderSetup cwd="/tmp" onClose={() => {}} onConnect={connect} />,
		{ cols: 100, rows: 30 },
	)
	await vi.waitFor(async () => {
		await screen!.waitForRender()
		expect(screen!.viewport().join('\n')).toContain('Not installed')
	})
	expect(screen.viewport().join('\n')).toContain('Zen free models · experimental')
	expect(screen.viewport().join('\n')).toContain('OpenCode installation recommended')
	expect(screen.viewport().join('\n')).toContain('gateway may refuse')
	expect(screen.viewport().join('\n')).toContain('Namzu connects directly')
	screen.press('i')
	await screen.waitForRender()
	expect(screen.viewport().join('\n')).toContain('npm install --global opencode-ai')
	expect(installHarness).not.toHaveBeenCalled()
	screen.press('n')
	await screen.waitForRender()
	expect(installHarness).not.toHaveBeenCalled()
	screen.press('i')
	await screen.waitForRender()
	screen.press('y')
	await vi.waitFor(() => expect(installHarness).toHaveBeenCalledOnce())
	await vi.waitFor(() => expect(probeHarnesses).toHaveBeenCalledTimes(2))
	await screen.waitForRender()
	expect(connect).not.toHaveBeenCalled()
	screen.press('c')
	await screen.waitForRender()
	expect(connect).toHaveBeenCalledOnce()
})
