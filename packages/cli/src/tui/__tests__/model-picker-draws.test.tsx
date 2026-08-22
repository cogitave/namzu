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
			// `constructible` is not decoration here. The picker now reads it
			// before accepting a row, and this literal did not carry it — so it
			// arrived as `undefined`, the refusal read that as "cannot build", and
			// seven cases in this file went red at once against a provider that
			// works perfectly in production. A fixture missing a field the code
			// under test reads is a system that does not ship
			// (`docs/conventions/fixture-must-match-production.md`).
			entry: {
				id: 'openai',
				label: 'A Provider',
				defaultModel: DEFAULT_MODEL,
				requiresApiKey: true,
				envVars: ['A_KEY'],
				constructible: true,
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
		{ id: 'model-two', name: 'Model Two', inputModalities: ['text', 'image'] },
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
		expect(lastFrame()).toContain('(image input)')
		unmount()
	})

	it('offers the namzu default alongside the listed models', async () => {
		const { lastFrame, stdin, unmount } = open()
		stdin.write('\r')
		await flush()
		expect(lastFrame()).toContain(DEFAULT_MODEL)
		expect(lastFrame()).toContain('(namzu default)')
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
		const signal = onSubmit.mock.calls[0]?.[1] as AbortSignal
		expect(signal.aborted).toBe(false)
		unmount()
		expect(signal.aborted).toBe(true)
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

	it('does not reopen after escape when the old listing arrives', async () => {
		let release: (value: ModelListing) => void = () => {}
		let seenSignal: AbortSignal | undefined
		const pending = new Promise<ModelListing>((resolve) => {
			release = resolve
		})
		const { lastFrame, stdin, unmount } = open({
			describeModels: (_id, _detected, signal) => {
				seenSignal = signal
				return pending
			},
		})

		stdin.write('\r')
		await flush()
		stdin.write('\x1B')
		await flush()
		expect(seenSignal?.aborted).toBe(true)
		expect(lastFrame()).toContain('Choose a provider')

		release(listing)
		await flush()
		expect(lastFrame()).toContain('Choose a provider')
		expect(lastFrame()).not.toContain('Choose a model')
		unmount()
	})

	it('lets the newest listing publish when an older one settles last', async () => {
		const releases: Array<(value: ModelListing) => void> = []
		const signals: AbortSignal[] = []
		const { lastFrame, stdin, unmount } = open({
			describeModels: (_id, _detected, signal) => {
				if (signal) signals.push(signal)
				return new Promise<ModelListing>((resolve) => releases.push(resolve))
			},
		})

		stdin.write('\r')
		await flush()
		stdin.write('\x1B')
		await flush()
		stdin.write('\r')
		await flush()
		expect(signals[0]?.aborted).toBe(true)
		expect(signals[1]?.aborted).toBe(false)

		releases[1]?.({ kind: 'ok', models: [{ id: 'new-model', name: 'Newest Model' }] })
		await flush()
		expect(lastFrame()).toContain('Newest Model')

		releases[0]?.({ kind: 'ok', models: [{ id: 'old-model', name: 'Old Model' }] })
		await flush()
		expect(lastFrame()).toContain('Newest Model')
		expect(lastFrame()).not.toContain('Old Model')
		unmount()
	})

	it('aborts listing when the picker unmounts', async () => {
		let seenSignal: AbortSignal | undefined
		const { stdin, unmount } = open({
			describeModels: (_id, _detected, signal) => {
				seenSignal = signal
				return new Promise(() => {})
			},
		})
		stdin.write('\r')
		await flush()
		unmount()
		expect(seenSignal?.aborted).toBe(true)
	})
})

/**
 * A provider this build cannot construct is shown and cannot be chosen.
 *
 * This is the surface #257 is really about: the operator did nothing wrong —
 * they picked from a list namzu put in front of them — and got an exception.
 * Detection is honest (the server IS running, the credential IS there), so the
 * row stays; what changes is that pressing enter refuses instead of saving a
 * choice that cannot start a session.
 */
describe('a detected provider with no bundled driver', () => {
	function unbuildable(): DetectedProvider[] {
		return [
			{
				entry: {
					id: 'lmstudio',
					label: 'A Local Server',
					defaultModel: DEFAULT_MODEL,
					requiresApiKey: false,
					envVars: [],
					constructible: false,
				},
				source: { kind: 'probe', url: 'http://localhost:1234/v1/models' },
				alternatives: [],
			} as unknown as DetectedProvider,
		]
	}

	it('refuses the selection and says why, instead of accepting it', async () => {
		const { stdin, lastFrame, onSubmit } = open({ detected: unbuildable() })
		await flush()

		stdin.write('\r')
		await flush()

		// Not submitted is the half that matters: accepting would write the
		// choice to preferences, and the next launch would refuse it.
		expect(onSubmit).not.toHaveBeenCalled()
		expect(lastFrame()).toMatch(/not available in this build/)
	})

	it('still lists the row, because the discovery behind it was true', async () => {
		// Excluding it would leave an operator who has only this provider staring
		// at "No providers detected", which is false — namzu found it and
		// declined it. A refusal that presents as an absence is not a refusal.
		const { lastFrame } = open({ detected: unbuildable() })
		await flush()

		expect(lastFrame()).toContain('A Local Server')
		expect(lastFrame()).toMatch(/unavailable in this build/)
	})

	it('does not refuse a provider whose driver IS bundled', async () => {
		// The preservation half. A refusal that fired for everyone would pass the
		// two cases above and break every session namzu can actually run.
		const { stdin, lastFrame } = open()
		await flush()

		stdin.write('\r')
		await flush()

		expect(lastFrame()).not.toMatch(/not available in this build/)
	})
})
