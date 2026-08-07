/**
 * The two-step `/model` picker draws, and its two navigation rules hold.
 *
 * `model-choices.test.ts` pins what the step is made of. This pins that the
 * step appears at all, that `esc` undoes one decision rather than two, and that
 * it opens on the model in force — three behaviours described in the PR and
 * pinned by nothing until now.
 *
 * Assertions name the specific thing rather than snapshotting the frame. A
 * whole-frame snapshot passes forever and fails on every cosmetic change, which
 * is the assertion that blocks everything and catches nothing.
 *
 * Not a terminal: wrapping, resize and scrollback are still unexercised.
 */

import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'

import type { DetectedProvider } from '../../integrations/providers/index.js'
import type { ModelListing } from '../agent.js'
import { Picker } from '../Picker.js'

const flush = () => new Promise((r) => setTimeout(r, 20))

const DEFAULT_MODEL = 'a-default-model'

function detected(): DetectedProvider[] {
	return [
		{
			entry: {
				id: 'openai',
				label: 'A Provider',
				defaultModel: DEFAULT_MODEL,
				requiresApiKey: true,
				envVars: ['A_KEY'],
			},
			source: { kind: 'env', envName: 'A_KEY' },
			apiKey: 'not-a-real-key',
			alternatives: [],
		} as unknown as DetectedProvider,
	]
}

const listing: ModelListing = {
	kind: 'ok',
	models: [
		{ id: 'model-one', name: 'Model One' },
		{ id: 'model-two', name: 'Model Two' },
	],
}

function open(overrides: Partial<Parameters<typeof Picker>[0]> = {}) {
	const onSubmit = vi.fn()
	const onCancel = vi.fn()
	const harness = render(
		<Picker
			detected={detected()}
			onSubmit={onSubmit}
			onCancel={onCancel}
			describeModels={async () => listing}
			{...overrides}
		/>,
	)
	return { ...harness, onSubmit, onCancel }
}

/** The row the cursor is on, by its marker. */
function selectedRow(frame: string): string | undefined {
	return frame.split('\n').find((l) => l.includes('❯'))
}

describe('the model step', () => {
	it('appears after a provider is accepted', async () => {
		const { lastFrame, stdin, unmount } = open()
		expect(lastFrame()).toContain('Choose a provider')

		stdin.write('\r')
		await flush()

		expect(lastFrame()).toContain('Choose a model')
		expect(lastFrame()).toContain('Model One')
		expect(lastFrame()).toContain('Model Two')
		unmount()
	})

	it('offers the provider default alongside the listed models', async () => {
		const { lastFrame, stdin, unmount } = open()
		stdin.write('\r')
		await flush()
		expect(lastFrame()).toContain(DEFAULT_MODEL)
		expect(lastFrame()).toContain('(default)')
		unmount()
	})

	it('opens on the model in force, not the default', async () => {
		// Re-opening the picker must not quietly reset the operator's choice.
		const { lastFrame, stdin, unmount } = open({ currentModel: 'model-two' })
		stdin.write('\r')
		await flush()

		const row = selectedRow(lastFrame() ?? '')
		expect(row, 'no row is selected').toBeDefined()
		expect(row).toContain('Model Two')
		expect(row).not.toContain('Model One')
		unmount()
	})

	it('opens on the default when nothing is in force', async () => {
		const { lastFrame, stdin, unmount } = open()
		stdin.write('\r')
		await flush()
		expect(selectedRow(lastFrame() ?? '')).toContain(DEFAULT_MODEL)
		unmount()
	})

	it('submits the model the cursor is on, not the provider default', async () => {
		const { stdin, unmount, onSubmit } = open({ currentModel: 'model-two' })
		stdin.write('\r')
		await flush()
		stdin.write('\r')
		await flush()

		expect(onSubmit).toHaveBeenCalledTimes(1)
		expect(onSubmit.mock.calls[0]?.[0]).toEqual({ provider: 'openai', model: 'model-two' })
		unmount()
	})
})

describe('esc from the model step', () => {
	it('returns to the provider list rather than leaving the picker', async () => {
		const { lastFrame, stdin, unmount, onCancel } = open()
		stdin.write('\r')
		await flush()
		expect(lastFrame()).toContain('Choose a model')

		stdin.write('\x1B')
		await flush()

		// Back one decision...
		expect(lastFrame()).toContain('Choose a provider')
		expect(lastFrame()).not.toContain('Choose a model')
		// ...and not out of the picker entirely.
		expect(onCancel).not.toHaveBeenCalled()
		unmount()
	})

	it('still leaves the picker from the provider list', async () => {
		// The other half: esc must not become inert. A key that undoes one step
		// and then does nothing is its own defect.
		const { stdin, unmount, onCancel } = open()
		stdin.write('\x1B')
		await flush()
		expect(onCancel).toHaveBeenCalledTimes(1)
		unmount()
	})
})

describe('while the list is still loading', () => {
	it('says so, and ignores input rather than acting on a list it does not have', async () => {
		let release: (l: ModelListing) => void = () => {}
		const pending = new Promise<ModelListing>((r) => {
			release = r
		})
		const { lastFrame, stdin, unmount, onSubmit } = open({ describeModels: () => pending })

		stdin.write('\r')
		await flush()
		expect(lastFrame()).toContain('what it has')

		// Enter here must not submit: there is no list to have chosen from.
		stdin.write('\r')
		await flush()
		expect(onSubmit).not.toHaveBeenCalled()

		release(listing)
		await flush()
		expect(lastFrame()).toContain('Model One')
		unmount()
	})
})
