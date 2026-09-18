/**
 * One vendor is one row, and the ways in are offered inside it.
 *
 * The defect: one vendor was two rows, because the registry models a
 * subscription sign-in and an API key as two provider ids. A machine with the
 * subscription signed in drew the subscription's own label on one line and,
 * under `Not detected`, the same vendor's name again asking for the key — so the
 * operator holding a key had to work out which of the two rows was theirs, and
 * the one with the subscription read a request for something they did not need.
 *
 * ## What is asserted here
 *
 * The grouping's own decisions are in `provider-list.test.ts`, where they are
 * pure. This file drives the screen: that the vendor is one row, that entering
 * it offers every way in with the detected one first, and that each choice
 * lands on the flow that already existed for it — the sign-in `l` starts, the
 * paste field whose value travels the session-credential path, and the model
 * step a detected provider has always gone to.
 *
 * It also pins what did NOT change: a row whose ways in belong to one provider
 * is not asked about, so Enter there means exactly what it always did.
 */

import { afterEach, expect, it, vi } from 'vitest'

import type { DetectedProvider } from '../../integrations/providers/index.js'
import { PROVIDER_REGISTRY } from '../../integrations/providers/index.js'
import { Picker } from '../Picker.js'
import type { ModelListing } from '../agent.js'
import { type Screen, renderToScreen } from './support/screen.js'

const KEY = 'sk-notarealkey-0123beef'
/** The one model each listing reports, so the model step always has something. */
const ONE_MODEL: ModelListing = {
	kind: 'ok',
	models: [{ id: 'gpt-5.6-sol', name: 'Sol', inputPrice: 1, outputPrice: 2 }],
}

const LOCAL_OLLAMA: DetectedProvider = {
	entry: PROVIDER_REGISTRY.ollama,
	source: { kind: 'probe', url: 'http://localhost:11434' },
	alternatives: [],
}

const LOCAL_LMSTUDIO: DetectedProvider = {
	entry: PROVIDER_REGISTRY.lmstudio,
	source: { kind: 'probe', url: 'http://localhost:1234/v1/models' },
	alternatives: [],
}

const CODEX_DEVICE: DetectedProvider = {
	entry: PROVIDER_REGISTRY.codex,
	source: { kind: 'codex-file', path: '/device/.codex/auth.json' },
	apiKey: 'never-render-this-token',
	alternatives: [],
}

let mounted: Screen | null = null

afterEach(async () => {
	await mounted?.unmount()
	mounted = null
})

async function open(overrides: Partial<Parameters<typeof Picker>[0]> = {}): Promise<Screen> {
	const screen = await renderToScreen(
		<Picker
			detected={[LOCAL_OLLAMA]}
			onSubmit={vi.fn()}
			onCancel={vi.fn()}
			onCredential={vi.fn()}
			verify={async () => ({ kind: 'verified' })}
			{...overrides}
		/>,
		{ cols: 100, rows: 24 },
	)
	mounted = screen
	await screen.waitForRender()
	return screen
}

/** The lines that carry a row number, which is what the list is made of. */
function rowLines(screen: Screen): string[] {
	return screen.viewport().filter((line) => /│ [› ] \d+\. /.test(line))
}

/** The row the cursor is on, by the marker the screen puts in front of it. */
function highlighted(screen: Screen): string {
	return screen.viewport().find((line) => line.includes('›')) ?? ''
}

/** Move the cursor down until the highlighted row names `label`. */
async function selectRow(screen: Screen, label: string): Promise<void> {
	for (let press = 0; press < 12; press += 1) {
		if (highlighted(screen).includes(label)) return
		screen.press('\x1B[B')
		await screen.waitForRender()
	}
	throw new Error(`the list never reached a row for ${label}`)
}

async function press(screen: Screen, input: string): Promise<void> {
	screen.press(input)
	await screen.waitForRender()
}

it('draws one row for a vendor whose subscription and key are two registry ids', async () => {
	const screen = await open({ detected: [CODEX_DEVICE, LOCAL_OLLAMA] })
	const viewport = screen.viewport().join('\n')

	// One row, and it is the detected one: the session this machine has, not a
	// request for the key it does not need. Both of those are the same vendor.
	expect(rowLines(screen).filter((line) => line.includes('OpenAI'))).toHaveLength(1)
	expect(viewport).toContain('Codex session · this device')
	expect(viewport).not.toContain('needs OPENAI_API_KEY')
	// Two detected vendors and the six that can still be set up: the second id of
	// this vendor did not add a row of its own.
	expect(rowLines(screen)).toHaveLength(8)
})

it('offers both ways in when the vendor row is entered, detected one first', async () => {
	const screen = await open({ detected: [CODEX_DEVICE, LOCAL_OLLAMA] })
	await selectRow(screen, 'OpenAI')
	await press(screen, '\r')
	const viewport = screen.viewport().join('\n')

	expect(viewport).toContain('Choose a way to use OpenAI')
	expect(viewport).toContain(
		'1. Use existing OpenAI (Codex subscription) · Codex session · this device',
	)
	expect(viewport).toContain('2. Enter a credential for OpenAI · needs OPENAI_API_KEY')
})

it('takes the session choice to the model step of that provider', async () => {
	const describeModels = vi.fn(async () => ONE_MODEL)
	const screen = await open({ detected: [CODEX_DEVICE, LOCAL_OLLAMA], describeModels })
	await selectRow(screen, 'OpenAI')
	await press(screen, '\r')
	await press(screen, '\r')

	await vi.waitFor(async () => {
		await screen.waitForRender()
		expect(screen.viewport().join('\n')).toContain('Choose a model · OpenAI (Codex subscription)')
	})
	expect(describeModels).toHaveBeenCalledWith('codex', expect.anything(), expect.anything())
})

it('takes the key choice to the paste field, whose value travels the session path', async () => {
	const onCredential = vi.fn()
	const screen = await open({ detected: [CODEX_DEVICE, LOCAL_OLLAMA], onCredential })
	await selectRow(screen, 'OpenAI')
	await press(screen, '\r')
	await press(screen, '2')
	await press(screen, '\r')

	expect(screen.viewport().join('\n')).toContain('Paste a credential for OpenAI')

	await press(screen, KEY)
	await press(screen, '\r')
	await vi.waitFor(() => expect(onCredential).toHaveBeenCalledTimes(1))
	const [credential] = onCredential.mock.calls[0] as [DetectedProvider]
	// The provider the key was entered for, and the record shape the session
	// layer already reads.
	expect(credential.entry.id).toBe('openai')
	expect(credential.apiKey).toBe(KEY)
	expect(credential.source).toEqual({ kind: 'session' })
})

it('asks for the key where nothing is detected, and still offers the sign-in', async () => {
	const onLogin = vi.fn(async () => 'awaiting-input' as const)
	const screen = await open({ detected: [LOCAL_OLLAMA], onLogin })
	await selectRow(screen, 'OpenAI')

	// The row says what the machine is missing before anything is entered.
	expect(screen.viewport().join('\n')).toContain('needs OPENAI_API_KEY')

	await press(screen, '\r')
	const viewport = screen.viewport().join('\n')
	expect(viewport).toContain('1. Enter a credential for OpenAI · needs OPENAI_API_KEY')
	expect(viewport).toContain('2. Sign in to OpenAI (Codex subscription) · device code')

	await press(screen, '2')
	await press(screen, '\r')
	await vi.waitFor(() => expect(onLogin).toHaveBeenCalledWith('codex', expect.anything()))
	// The same operation `l` starts, reached from the vendor it belongs to.
	expect(screen.viewport().join('\n')).toContain('Complete OpenAI (Codex subscription) sign-in')
})

it('keeps Enter going straight through where a row has one provider behind it', async () => {
	// The question "which provider did you mean" is asked only where there is
	// more than one answer. Every other row keeps the keystroke it always took:
	// a detected row opens its models, an unconfigured row opens its paste field.
	const describeModels = vi.fn(async () => ONE_MODEL)
	const detected = await open({ detected: [LOCAL_OLLAMA], describeModels })
	await press(detected, '\r')
	await vi.waitFor(async () => {
		await detected.waitForRender()
		expect(detected.viewport().join('\n')).toContain('Choose a model · Ollama (local)')
	})

	const unconfigured = await open({ detected: [LOCAL_OLLAMA] })
	await selectRow(unconfigured, 'DeepSeek')
	await press(unconfigured, '\r')
	expect(unconfigured.viewport().join('\n')).toContain('Paste a credential for DeepSeek')
	expect(unconfigured.viewport().join('\n')).not.toContain('Choose a way to use')
})

it('returns to the row it came from when the ways-in screen is left', async () => {
	const screen = await open({ detected: [CODEX_DEVICE, LOCAL_OLLAMA] })
	await selectRow(screen, 'OpenAI')
	await press(screen, '\r')
	await press(screen, '\x1B')

	// A lone escape is held for a moment while the renderer decides whether an
	// arrow key is coming, so the screen it produces is waited for rather than
	// read straight after the press.
	await vi.waitFor(async () => {
		await screen.waitForRender()
		expect(screen.viewport().join('\n')).toContain('Choose a provider')
	})
	expect(highlighted(screen)).toContain('OpenAI')
})

it('cannot draw a tenth row, which is where the digit shortcut used to stop', async () => {
	// Three vendors detected and the rest appended used to be ten rows, because
	// the vendor with a subscription and a key was counted twice. Grouping took
	// the duplicate out, so the nine-row limit the digit shortcut has is now a
	// bound this list cannot pass rather than one it can overshoot.
	const screen = await open({ detected: [CODEX_DEVICE, LOCAL_OLLAMA, LOCAL_LMSTUDIO] })

	expect(rowLines(screen)).toHaveLength(9)
	expect(screen.viewport().join('\n')).not.toContain('Rows past 9')
})
