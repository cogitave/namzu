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

describe('the no-credential screen', () => {
	it('offers the key entry rather than only telling you to restart', async () => {
		const { lastFrame, unmount } = open()
		expect(lastFrame()).toContain('No providers detected')
		// The cliff this closes: the screen used to end at "restart namzu".
		expect(lastFrame()).toContain('restart namzu')
		// "credential" and not "key": the screen accepts a subscription token as
		// well, and a field labelled for one of the two kinds is a field the
		// holder of the other kind will not use.
		expect(lastFrame()).toMatch(/press .*k.* to paste a credential|k: enter a credential/s)
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
			verify: async () => ({ kind: 'rejected', reason: 'HTTP 401 invalid x-api-key' }),
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
		const [cred, disposition] = onCredential.mock.calls[0] as [DetectedProvider, string]
		expect(cred.apiKey).toBe(KEY)
		expect(cred.source).toEqual({ kind: 'session' })
		// The sentence the operator reads afterwards says it again.
		expect(disposition).toContain('this session only')
		expect(disposition).not.toContain(KEY)
		unmount()
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
})
