/**
 * Every provider a user can set up is on the list, and picking one leads to
 * the field that sets it up.
 *
 * The defect: the picker listed what discovery found. An operator whose saved
 * provider was OpenRouter, holding an OpenRouter key that was not exported as
 * an environment variable, saw the four providers the machine had detected and
 * no OpenRouter anywhere — so there was no row to select and therefore no way
 * to type the key. A list assembled from `detected` cannot contain a provider
 * `detected` does not mention, whatever the operator is holding.
 *
 * ## What is asserted here, and what is asserted next door
 *
 * `provider-list.test.ts` decides the list itself — which rows, in what order,
 * under which heading. This file drives the screen: that those rows are drawn,
 * that Enter on one opens the credential field instead of submitting a
 * provider with nothing to submit, that the typed value reaches the caller
 * carrying THAT provider's id, and that the detected rows and the header's
 * count are exactly what they were before.
 *
 * Not a terminal: this renders to a string through `ink-testing-library`. Line
 * wrapping at a real width and the scrollback region are not exercised.
 */

import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'

import type { DetectedProvider } from '../../integrations/providers/index.js'
import { PROVIDER_REGISTRY } from '../../integrations/providers/index.js'
import { Picker } from '../Picker.js'
import { credentialNeed } from '../provider-list.js'

/** Let ink flush a render after input. */
const flush = () => new Promise((r) => setTimeout(r, 20))

const LOCAL_OLLAMA: DetectedProvider = {
	entry: PROVIDER_REGISTRY.ollama,
	source: { kind: 'probe', url: 'http://localhost:11434' },
	alternatives: [],
}

const CODEX_DEVICE: DetectedProvider = {
	entry: PROVIDER_REGISTRY.codex,
	source: { kind: 'codex-file', path: '/device/.codex/auth.json' },
	apiKey: 'never-render-this-token',
	alternatives: [],
}

const LOCAL_LMSTUDIO: DetectedProvider = {
	entry: PROVIDER_REGISTRY.lmstudio,
	source: { kind: 'probe', url: 'http://localhost:1234/v1/models' },
	alternatives: [],
}

const KEY = 'sk-or-v1-notarealkey-0123beef'

function open(overrides: Partial<Parameters<typeof Picker>[0]> = {}) {
	const onCredential = vi.fn()
	const onSubmit = vi.fn()
	const harness = render(
		<Picker
			detected={[LOCAL_OLLAMA]}
			onSubmit={onSubmit}
			onCancel={vi.fn()}
			onCredential={onCredential}
			verify={async () => ({ kind: 'verified' })}
			{...overrides}
		/>,
	)
	return { ...harness, onCredential, onSubmit }
}

/** The row the cursor is on, by the marker the screen puts in front of it. */
function highlighted(frame: string | undefined): string {
	return (
		(frame ?? '')
			.split('\n')
			.find((line) => line.includes('›')) ?? ''
	)
}

/** Move the cursor down until `label` is the highlighted row. */
async function moveTo(
	lastFrame: () => string | undefined,
	stdin: { write: (input: string) => void },
	label: string,
): Promise<void> {
	for (let press = 0; press < 12; press += 1) {
		if (highlighted(lastFrame()).includes(label)) return
		stdin.write('\x1B[B')
		await flush()
	}
	throw new Error(`the list never reached a row for ${label}`)
}

describe('the provider list', () => {
	it('lists a provider this machine does not have, under the variable it needs', () => {
		const { lastFrame, unmount } = open()
		const frame = lastFrame() ?? ''

		expect(frame).toContain(PROVIDER_REGISTRY.openrouter.label)
		expect(frame).toContain(credentialNeed(PROVIDER_REGISTRY.openrouter))
		// The heading says which rows are the new ones, so the appended block is
		// not mistaken for more of what was found.
		expect(frame).toContain('Not detected — enter a credential to use these:')
		unmount()
	})

	it('keeps the detected rows and the header exactly as they were', () => {
		// The claim the change had to keep true. A detected row is what an
		// operator reads every day, and the header's count is a statement about
		// the machine that adding rows to the screen must not quietly widen.
		const { lastFrame, unmount } = open()
		const frame = lastFrame() ?? ''

		expect(highlighted(frame)).toMatch(/› 1\. Ollama \(local\)\s+local · localhost:11434/)
		expect(frame).toContain(
			'1 detected · device sessions / Namzu sign-ins / optional keys / local probes',
		)
		unmount()
	})

	it('does not offer a provider a typed credential cannot set up', () => {
		// A row that leads nowhere is worse than an absent row, so these are
		// omitted rather than drawn greyed out — see `provider-list.ts` for the
		// reason attached to each.
		const { lastFrame, unmount } = open()
		const frame = lastFrame() ?? ''

		expect(frame).not.toContain(PROVIDER_REGISTRY.bedrock.label)
		expect(frame).not.toContain(PROVIDER_REGISTRY.lmstudio.label)
		expect(frame).not.toContain(PROVIDER_REGISTRY.codex.label)
		unmount()
	})

	it('numbers every row it can hold, so the digit shortcut reaches the last one', async () => {
		// Three detected vendors and the six that can still be set up is nine rows,
		// which is one per vendor and the most this screen can ever draw. Ten is
		// where one keystroke per row runs out, so the sentence about the rows past
		// nine has nothing to say here — it stayed in the screen for the day a
		// tenth vendor arrives, and this asserts the state that makes it quiet.
		const { lastFrame, stdin, unmount } = open({
			detected: [CODEX_DEVICE, LOCAL_OLLAMA, LOCAL_LMSTUDIO],
		})

		expect(lastFrame()).not.toContain('Rows past 9')

		await moveTo(lastFrame, stdin, PROVIDER_REGISTRY.openrouter.label)
		expect(highlighted(lastFrame())).toContain(PROVIDER_REGISTRY.openrouter.label)

		// The digit reaches the last row there is, which is the whole claim a
		// one-keystroke-per-row shortcut can make.
		stdin.write('9')
		await flush()
		expect(highlighted(lastFrame())).toContain(PROVIDER_REGISTRY['zen-go'].label)
		unmount()
	})
})

describe('picking a provider that has no credential yet', () => {
	it('opens the credential field instead of submitting what cannot start', async () => {
		const { lastFrame, stdin, unmount, onSubmit } = open()
		await moveTo(lastFrame, stdin, PROVIDER_REGISTRY.openrouter.label)

		stdin.write('\r')
		await flush()

		expect(lastFrame()).toContain(`Paste a credential for ${PROVIDER_REGISTRY.openrouter.label}`)
		expect(onSubmit).not.toHaveBeenCalled()
		unmount()
	})

	it('hands the typed key up for that provider, not for the first one listed', async () => {
		const { lastFrame, stdin, unmount, onCredential } = open()
		await moveTo(lastFrame, stdin, PROVIDER_REGISTRY.openrouter.label)
		stdin.write('\r')
		await flush()

		stdin.write(KEY)
		await flush()
		stdin.write('\r')
		await flush()

		expect(onCredential).toHaveBeenCalledTimes(1)
		const [credential] = onCredential.mock.calls[0] as [DetectedProvider]
		expect(credential.entry.id).toBe('openrouter')
		expect(credential.apiKey).toBe(KEY)
		// The path the session layer already reads: a discovered-shaped record
		// whose only difference is where the credential came from.
		expect(credential.source).toEqual({ kind: 'session' })
		unmount()
	})

	it('takes `k` for the highlighted row too, which is what the footer says it does', async () => {
		const { lastFrame, stdin, unmount } = open()
		await moveTo(lastFrame, stdin, PROVIDER_REGISTRY.deepseek.label)

		stdin.write('k')
		await flush()

		expect(lastFrame()).toContain(`Paste a credential for ${PROVIDER_REGISTRY.deepseek.label}`)
		unmount()
	})

	it('does not fold the rows that cannot take one into the key it advertises', async () => {
		// `k` follows the cursor, so on a row that takes no typed credential the
		// footer must stop naming one rather than offer a field that would be
		// built for a provider the operator did not pick.
		const { lastFrame, stdin, unmount } = open()
		stdin.write('k')
		await flush()

		// Row 1 is the local server: `k` has nothing to open for it, and says so
		// without pretending something happened.
		expect(lastFrame()).toContain('does not take a typed credential')
		expect(lastFrame()).not.toContain('Paste a credential')
		unmount()
	})

	it('still takes a credential for the provider the picker was opened for', async () => {
		// The route that already existed, kept: the saved provider whose key is
		// missing wins when the highlighted row cannot take one, because the
		// notice above the list says `k` is how to supply it.
		const { lastFrame, stdin, unmount } = open({ keyEntryFor: 'anthropic' })
		stdin.write('k')
		await flush()

		expect(lastFrame()).toContain(`Paste a credential for ${PROVIDER_REGISTRY.anthropic.label}`)
		unmount()
	})
})
