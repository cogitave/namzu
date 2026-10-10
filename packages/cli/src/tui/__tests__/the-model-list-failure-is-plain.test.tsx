/**
 * What the model step says when the provider refused to list its models, drawn
 * at 40, 60 and 80 columns. The driver's text (a status line, a masked key, a
 * request ID) never reaches the screen; the person gets one sentence and a
 * next step that names the key.
 */

import { appendFileSync } from 'node:fs'

import { Box } from 'ink'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PROVIDER_REGISTRY } from '../../integrations/providers/index.js'
import type { DetectedProvider } from '../../integrations/providers/index.js'
import { Picker } from '../Picker.js'
import { type Screen, renderToScreen } from './support/screen.js'

const RAW =
	'401 Authentication Fails, Your api key: ****real is invalid (request_id: req_abc123def456)'

const providers: readonly DetectedProvider[] = [
	{
		entry: PROVIDER_REGISTRY.deepseek,
		source: { kind: 'env', envName: 'DEEPSEEK_API_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
]

let mounted: Screen | null = null
afterEach(async () => {
	await mounted?.unmount()
	mounted = null
})

describe.each([40, 60, 80])('a rejected key at %i columns', (cols) => {
	it('says it in one sentence and keeps the driver text off the screen', async () => {
		const screen = await renderToScreen(
			<Box paddingX={1}>
				<Picker
					detected={providers}
					onSubmit={vi.fn()}
					onCancel={vi.fn()}
					onCredential={vi.fn()}
					describeModels={async () => ({
						kind: 'failed',
						reason: RAW,
						cause: 'rejected',
					})}
				/>
			</Box>,
			{ cols, rows: 30 },
		)
		mounted = screen
		await screen.waitForRender()
		screen.press('\r')
		await screen.waitForRender()
		const frame = screen.viewport().join('\n')
		if (process.env.PROBE) appendFileSync(process.env.PROBE, `--- ${cols}\n${frame}\n`)
		expect(frame.replace(/[│\s]+/g, ' ')).toContain('DeepSeek rejected the saved API key.')
		expect(frame).not.toMatch(/request_id|\*\*\*\*|Authentication Fails|401/)
	})
})
