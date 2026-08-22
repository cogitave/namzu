/** Model-scoped rich-content refusals cross the full rendered App boundary. */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { TuiContext } from '../types.js'

const fixture = vi.hoisted(() => ({
	clipboard: {
		kind: 'image' as const,
		image: { data: 'AAAA', mediaType: 'image/png' as const },
	},
}))

vi.mock('../../integrations/clipboard/image.js', () => ({
	readClipboardImage: () => fixture.clipboard,
}))
vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../integrations/updates.js', () => ({
	checkUpdates: async () => [],
}))

vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({
			preferences: {
				version: 3 as const,
				providers: [{ id: 'deepseek' as const }],
				subagents: { active: [] },
			},
			needsRepickReason: null,
			credentialGap: null,
			detected: [
				{
					entry: {
						id: 'deepseek',
						label: 'DeepSeek',
						envVars: ['DEEPSEEK_API_KEY'],
						defaultBaseUrl: 'https://api.deepseek.com',
						defaultModel: 'deepseek-v4-flash',
						requiresApiKey: true,
						constructible: true,
					},
					source: { kind: 'env', envName: 'DEEPSEEK_API_KEY' },
					apiKey: 'not-a-real-key',
					alternatives: [],
				},
			],
		}),
	}
})

const { App } = await import('../App.js')
const roots: string[] = []
const mounted: Array<{ unmount: () => void }> = []
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(() => {
	for (const harness of mounted.splice(0)) harness.unmount()
	for (const root of roots.splice(0)) removeTempDir(root)
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

async function until(check: () => boolean, why: string): Promise<void> {
	const started = performance.now()
	while (!check() && performance.now() - started < 5_000) await tick(20)
	expect(check(), why).toBe(true)
}

it('renders the real DeepSeek text-model refusal without a false driver warning', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-deepseek-capability-app-'))
	roots.push(cwd)
	const network = vi.fn(() => {
		throw new Error('network must not be reached for a locally unsupported attachment')
	})
	vi.stubGlobal('fetch', network)
	const harness = render(<App ctx={{ cwd, version: '0.0.0-test' } as TuiContext} />)
	mounted.push(harness)
	await until(
		() => (harness.lastFrame() ?? '').includes('Connected to DeepSeek'),
		'App did not publish the real provider session',
	)
	await tick(600)

	harness.stdin.write('\x16')
	await tick(150)
	expect(harness.lastFrame(), 'image was not attached').toContain('Image #1')
	harness.stdin.write('inspect this image')
	await tick()
	harness.stdin.write('\r')
	await until(
		() => harness.frames.join('\n').includes('Error:'),
		'the provider refusal did not reach the transcript',
	)

	const rendered = harness.frames.join('\n')
	expect(rendered).not.toContain('Capability warning (vision)')
	expect(rendered).toContain("model 'deepseek-v4-flash' does not accept image input")
	expect(rendered).toContain("Select 'deepseek-v4-flash-vision-exp'")
	expect(network).not.toHaveBeenCalled()
})
