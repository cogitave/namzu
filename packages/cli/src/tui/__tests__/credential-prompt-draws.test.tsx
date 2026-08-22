/**
 * The credential prompt draws, and it does not draw the key.
 *
 * These two screens shipped with their logic pinned and their rendering
 * unverified — nobody could see them but the owner. `ink-testing-library`
 * renders to a string, so `lastFrame()` is a screenshot that can be asserted on
 * and reviewed in a diff, which an image cannot.
 *
 * ## What is asserted, and what is deliberately not
 *
 * Not a snapshot of the whole frame. That passes forever, fails on every
 * unrelated cosmetic change, and catches nothing in between — the assertion
 * that blocks everything and proves nothing. Each test names the specific thing
 * it is about: the absence of the key, the sentence, the provider's own reason.
 *
 * ## What a rendered frame still cannot tell you
 *
 * This is not a terminal. Line wrapping at a real width, resize, and how ink's
 * `<Static>` scrollback interacts with the live region are not exercised here.
 * "The prompt draws and hides the key" moves from unverified to pinned; how it
 * behaves in a 60-column window does not.
 */

import { render } from 'ink-testing-library'
import { describe, expect, it, vi } from 'vitest'

import type { DetectedProvider } from '../../integrations/providers/index.js'
import { PROVIDER_REGISTRY } from '../../integrations/providers/index.js'
import { Picker } from '../Picker.js'

const KEY = 'sk-ant-api03-notarealkey-0123beef'

/** Let ink flush a render after input. */
const flush = () => new Promise((r) => setTimeout(r, 20))

function open(overrides: Partial<Parameters<typeof Picker>[0]> = {}) {
	const onCredential = vi.fn()
	const harness = render(
		<Picker
			detected={[]}
			onSubmit={vi.fn()}
			onCancel={vi.fn()}
			onCredential={onCredential}
			verify={async () => ({ kind: 'verified' })}
			{...overrides}
		/>,
	)
	return { ...harness, onCredential }
}

const SIGNED_IN_CLAUDE: DetectedProvider = {
	entry: PROVIDER_REGISTRY['anthropic'],
	source: { kind: 'claude-file', path: '/device/.claude/.credentials.json' },
	apiKey: 'never-render-this-token',
	alternatives: [],
}

const API_KEY_OPENAI: DetectedProvider = {
	entry: PROVIDER_REGISTRY['openai'],
	source: { kind: 'env', envName: 'OPENAI_API_KEY' },
	apiKey: 'never-render-this-key',
	alternatives: [],
}

describe('the no-credential screen', () => {
	it('offers the key entry rather than only telling you to restart', async () => {
		const { lastFrame, unmount } = open()
		expect(lastFrame()).toContain('No providers detected')
		// The cliff this closes: the screen used to end at restarting.
		expect(lastFrame()).toContain('restart')
		// "credential" and not "key": the screen accepts a subscription token as
		// well, and a field labelled for one of the two kinds is a field the
		// holder of the other kind will not use.
		expect(lastFrame()).toMatch(/press .*k.* to paste a credential|k: enter a credential/s)
		unmount()
	})

	/**
	 * The screen an operator with nothing reaches has to name every way out.
	 *
	 * It shipped naming three sources and two exits while a working sign-in
	 * existed, because the sign-in was a slash command and this screen has no
	 * composer to type one into. The operator was told to set an environment
	 * variable and restart.
	 */
	it('offers the sign-in, which is the only exit that needs no credential at all', async () => {
		const onLogin = vi.fn()
		const { lastFrame, stdin, unmount } = open({ onLogin })
		expect(lastFrame()).toMatch(/press .*l.* to sign in|l: sign in/s)
		stdin.write('l')
		await flush()
		expect(lastFrame()).toContain('Choose a subscription')
		expect(lastFrame()).toContain('Anthropic (Claude)')
		expect(lastFrame()).toContain('OpenAI (Codex subscription)')
		stdin.write('\r')
		await flush()
		expect(onLogin).toHaveBeenCalledTimes(1)
		expect(onLogin.mock.calls[0]?.[0]).toBe('anthropic')
		unmount()
	})

	it('accepts the capital, because a person reading "press l" may hold shift', async () => {
		const onLogin = vi.fn()
		const { stdin, unmount } = open({ onLogin })
		stdin.write('L')
		await flush()
		stdin.write('\r')
		await flush()
		expect(onLogin).toHaveBeenCalledTimes(1)
		unmount()
	})

	it('lets the operator choose Codex instead of hard-coding Claude', async () => {
		const onLogin = vi.fn()
		const { stdin, unmount } = open({ onLogin })
		stdin.write('l')
		await flush()
		stdin.write('\x1B[B')
		await flush()
		stdin.write('\r')
		await flush()
		expect(onLogin).toHaveBeenCalledTimes(1)
		expect(onLogin.mock.calls[0]?.[0]).toBe('codex')
		unmount()
	})

	it('does not offer a sign-in it cannot start', async () => {
		// No handler means no route, and a key hint for a keystroke that does
		// nothing is worse than no hint: it spends the one attempt an operator
		// makes before concluding the screen is broken.
		const { lastFrame, unmount } = open()
		expect(lastFrame()).not.toMatch(/l: sign in/)
		unmount()
	})

	it('names the credential store among the sources it scans', async () => {
		// The list is what an operator is told to try. The store the sign-in
		// writes was missing from it for a release, so the screen scanned a
		// source it never mentioned.
		const { lastFrame, unmount } = open()
		expect(lastFrame()).toContain('.namzu/credentials.json')
		unmount()
	})
})

describe('subscription-first provider choice', () => {
	it('uses an already signed-in provider directly without a second model screen', async () => {
		const onSubmit = vi.fn()
		const { lastFrame, stdin, unmount } = render(
			<Picker
				detected={[SIGNED_IN_CLAUDE]}
				selectionKind="signed-in-subscription"
				onSubmit={onSubmit}
				onCancel={vi.fn()}
			/>,
		)

		expect(lastFrame()).toContain('Choose a signed-in subscription')
		expect(lastFrame()).toContain('no API key required')
		stdin.write('\r')
		await flush()

		expect(onSubmit).toHaveBeenCalledTimes(1)
		expect(onSubmit.mock.calls[0]?.[0]).toEqual({ provider: 'anthropic' })
		expect(lastFrame()).not.toContain('Choose a model')
		unmount()
	})

	it('keeps subscription sign-in reachable when an optional API key was detected', async () => {
		const onLogin = vi.fn()
		const { lastFrame, stdin, unmount } = render(
			<Picker
				detected={[API_KEY_OPENAI]}
				onSubmit={vi.fn()}
				onCancel={vi.fn()}
				onLogin={onLogin}
			/>,
		)

		expect(lastFrame()).toContain('l create a Namzu sign-in')
		stdin.write('l')
		await flush()
		expect(lastFrame()).toContain('Anthropic (Claude)')
		expect(lastFrame()).toContain('OpenAI (Codex subscription)')
		unmount()
	})
})

describe('the credential prompt', () => {
	it('appears when k is pressed', async () => {
		const { lastFrame, stdin, unmount } = open()
		stdin.write('k')
		await flush()
		expect(lastFrame()).toContain('Paste a credential')
		unmount()
	})

	it('says the key is session-only BEFORE anything is typed', async () => {
		// Before, not after. Someone deciding whether to paste a secret needs the
		// disposition at the moment they decide, not once it is already typed.
		const { lastFrame, stdin, unmount } = open()
		stdin.write('k')
		await flush()
		expect(lastFrame()).toContain('this session only')
		expect(lastFrame()).toContain('not written anywhere')
		unmount()
	})

	it('does not echo the key', async () => {
		// The assertion that matters most here: this is a security property and it
		// was shipped unverified.
		const { lastFrame, stdin, unmount } = open()
		stdin.write('k')
		await flush()
		stdin.write(KEY)
		await flush()

		const frame = lastFrame() ?? ''
		expect(frame).not.toContain(KEY)
		expect(frame).not.toContain('api03')
		expect(frame).not.toContain('notarealkey')
		// The mask is on screen, so something is visibly happening as they type.
		expect(frame).toContain('••••')
		unmount()
	})

	it('shows a tail so a wrong paste is recognisable, and nothing more', async () => {
		const { lastFrame, stdin, unmount } = open()
		stdin.write('k')
		await flush()
		stdin.write(KEY)
		await flush()

		const frame = lastFrame() ?? ''
		expect(frame).toContain('beef')
		// Four characters of tail, not five: the character before the tail must
		// not be on screen.
		expect(frame).not.toContain('3beef')
		unmount()
	})

	it('surfaces the provider’s own reason when a key is rejected', async () => {
		const { lastFrame, stdin, unmount, onCredential } = open({
			verify: async () => ({
				kind: 'rejected',
				reason: 'HTTP 401 invalid x-api-key',
			}),
		})
		stdin.write('k')
		await flush()
		stdin.write(KEY)
		await flush()
		stdin.write('\r')
		await flush()

		const frame = lastFrame() ?? ''
		// The provider's words, not "could not verify key".
		expect(frame).toContain('HTTP 401')
		expect(frame).toContain('Nothing was stored')
		// Still on the screen, so a one-character slip is fixable...
		expect(frame).toContain('Paste a credential')
		// ...and the key is still not on it.
		expect(frame).not.toContain(KEY)
		expect(onCredential).not.toHaveBeenCalled()
		unmount()
	})

	it('hands the credential up, with the disposition, when accepted', async () => {
		const { stdin, unmount, onCredential } = open()
		stdin.write('k')
		await flush()
		stdin.write(KEY)
		await flush()
		stdin.write('\r')
		await flush()

		expect(onCredential).toHaveBeenCalledTimes(1)
		const [cred, disposition, signal] = onCredential.mock.calls[0] as [
			DetectedProvider,
			string,
			AbortSignal,
		]
		expect(cred.apiKey).toBe(KEY)
		expect(cred.source).toEqual({ kind: 'session' })
		// The sentence the operator reads afterwards says it again.
		expect(disposition).toContain('this session only')
		expect(disposition).not.toContain(KEY)
		expect(signal.aborted).toBe(false)
		unmount()
		expect(signal.aborted).toBe(true)
	})

	it('escapes back out without keeping anything', async () => {
		const { lastFrame, stdin, unmount, onCredential } = open()
		stdin.write('k')
		await flush()
		stdin.write(KEY)
		await flush()
		stdin.write('\x1B')
		await flush()

		expect(lastFrame()).toContain('No providers detected')
		expect(lastFrame()).not.toContain(KEY)
		expect(onCredential).not.toHaveBeenCalled()
		unmount()
	})

	it('withdraws a check that was already in flight', async () => {
		let finish: (result: { kind: 'verified' }) => void = () => {}
		let seenSignal: AbortSignal | undefined
		const pending = new Promise<{ kind: 'verified' }>((resolve) => {
			finish = resolve
		})
		const { lastFrame, stdin, unmount, onCredential } = open({
			verify: (_id, _credential, signal) => {
				seenSignal = signal
				return pending
			},
		})

		stdin.write('k')
		await flush()
		stdin.write(KEY)
		await flush()
		stdin.write('\r')
		await flush()
		expect(lastFrame()).toContain('Checking')

		stdin.write('\x1B')
		await flush()
		expect(seenSignal?.aborted).toBe(true)
		expect(lastFrame()).toContain('No providers detected')

		finish({ kind: 'verified' })
		await flush()
		expect(onCredential, 'a cancelled credential was accepted later').not.toHaveBeenCalled()
		expect(lastFrame()).toContain('No providers detected')
		unmount()
	})

	it('aborts a pending check when the picker unmounts', async () => {
		let seenSignal: AbortSignal | undefined
		const { stdin, unmount } = open({
			verify: (_id, _credential, signal) => {
				seenSignal = signal
				return new Promise(() => {})
			},
		})

		stdin.write('k')
		await flush()
		stdin.write(KEY)
		await flush()
		stdin.write('\r')
		await flush()
		unmount()

		expect(seenSignal?.aborted).toBe(true)
	})
})
