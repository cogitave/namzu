import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { LocalListeningState } from '../shared/local-listening-protocol.js'
import type { LocalListeningSnapshot } from './use-local-listening.js'
import type { VoiceInputControls } from './use-voice-input.js'
import {
	MIC_NEEDS_CONVERSATION,
	MIC_NEEDS_DOWNLOAD,
	VoiceInputStatus,
	VoiceMicButton,
	micPresentation,
} from './voice-input-ui.js'

const engineState = (installation: LocalListeningState['installation']): LocalListeningState => ({
	installation,
	engine: 'unloaded',
	device: 'cpu',
	downloadBytes: 1_037_257_645,
	diskBytes: null,
})
const engine = (
	installation: LocalListeningState['installation'] | null = 'ready',
): Pick<LocalListeningSnapshot, 'state' | 'loading' | 'supported'> => ({
	state: installation ? engineState(installation) : null,
	loading: installation === null,
	supported: true,
})
const voice = (over: Partial<VoiceInputControls> = {}): VoiceInputControls => ({
	supported: true,
	phase: 'off',
	consentOpen: false,
	accepted: true,
	toggle: vi.fn(),
	acceptConsent: vi.fn(async () => undefined),
	declineConsent: vi.fn(),
	dismissNotice: vi.fn(),
	...over,
})
const mic = (controls: VoiceInputControls, listening = engine(), hasConversation = true) =>
	renderToStaticMarkup(
		createElement(VoiceMicButton, {
			voice: controls,
			engine: listening,
			hasConversation,
			onOpenSettings: () => {},
		}),
	)
const status = (controls: VoiceInputControls) =>
	renderToStaticMarkup(createElement(VoiceInputStatus, { voice: controls }))

describe('the microphone button', () => {
	it('off: a quiet icon button that offers to turn voice input on', () => {
		const markup = mic(voice())
		expect(markup).toContain('aria-label="Turn on voice input"')
		expect(markup).toContain('aria-pressed="false"')
		expect(markup).toContain('data-phase="off"')
		expect(markup).toContain('aria-disabled="false"')
		expect(markup).not.toContain('voice-mic-dot')
		// A quiet icon, not a filled or outlined text button.
		expect(markup).not.toMatch(/Turn on voice input<\/button>/)
		expect(markup).not.toContain('border-input')
	})

	it.each(['starting', 'listening', 'hearing', 'transcribing'] as const)(
		'%s: pressed, with the open-microphone dot',
		(phase) => {
			const markup = mic(voice({ phase }))
			expect(markup).toContain(`data-phase="${phase}"`)
			expect(markup).toContain('aria-pressed="true"')
			expect(markup).toContain('aria-label="Turn off voice input"')
			expect(markup).toContain('voice-mic-dot')
		},
	)

	it('not downloaded: disabled with the reason, and offers Settings', () => {
		const markup = mic(voice(), engine('missing'))
		expect(markup).toContain('aria-disabled="true"')
		expect(markup).toContain(MIC_NEEDS_DOWNLOAD)
		expect(markup).not.toContain(' disabled=""')
		const view = micPresentation({
			voice: voice(),
			engine: engine('missing'),
			hasConversation: true,
		})
		expect(view).toMatchObject({ reason: MIC_NEEDS_DOWNLOAD, opensSettings: true })
		for (const installation of ['installing', 'failed'] as const)
			expect(
				micPresentation({ voice: voice(), engine: engine(installation), hasConversation: true })
					.opensSettings,
			).toBe(true)
	})

	it('no conversation yet: disabled with the reason, nothing to open', () => {
		const view = micPresentation({ voice: voice(), engine: engine(), hasConversation: false })
		expect(view).toMatchObject({ reason: MIC_NEEDS_CONVERSATION, opensSettings: false })
		expect(mic(voice(), engine(), false)).toContain('aria-disabled="true"')
	})

	it('still checking: disabled, does not claim a download is needed', () => {
		const view = micPresentation({ voice: voice(), engine: engine(null), hasConversation: true })
		expect(view.reason).toBe('Checking voice input…')
		expect(view.opensSettings).toBe(false)
	})

	it('a listening microphone can always be turned off, whatever else changed', () => {
		const view = micPresentation({
			voice: voice({ phase: 'listening' }),
			engine: engine('missing'),
			hasConversation: false,
		})
		expect(view.reason).toBeUndefined()
		expect(view.label).toBe('Turn off voice input')
	})

	it('is absent where voice input is not supported', () => {
		expect(mic(voice({ supported: false }))).toBe('')
		expect(mic(voice(), { ...engine(), supported: false })).toBe('')
	})

	it('uses plain words only', () => {
		const everything = [
			MIC_NEEDS_DOWNLOAD,
			MIC_NEEDS_CONVERSATION,
			...(['off', 'starting', 'listening', 'hearing', 'transcribing'] as const).map(
				(phase) =>
					micPresentation({ voice: voice({ phase }), engine: engine(), hasConversation: true })
						.label,
			),
		].join(' ')
		expect(everything).not.toMatch(/session|turn id|runtime|IPC|error|exception/i)
	})
})

describe('the status area', () => {
	it('is empty while off', () => {
		expect(status(voice())).toBe('')
	})

	it.each([
		['starting', 'Starting the microphone…'],
		['listening', 'Listening. Say “dur” to stop a reply.'],
		['hearing', 'Hearing you…'],
		['transcribing', 'Writing down what you said…'],
	] as const)('always shows that the microphone is open: %s', (phase, text) => {
		const markup = status(voice({ phase }))
		expect(markup).toContain('voice-listening')
		expect(markup).toContain(text.replace('“', '“'))
	})

	it('the first press shows the plain-words consent, with both choices', () => {
		const markup = status(voice({ consentOpen: true, accepted: false }))
		for (const text of [
			'Turn on voice input?',
			'Namzu listens only while the microphone is on.',
			'Your audio stays on this computer.',
			'What you say is sent as a message, the same as typing it.',
			'Voice can’t approve actions. Questions about permissions are answered on screen.',
			'Turn on voice input</button>',
			'Not now</button>',
		])
			expect(markup).toContain(text)
		expect(markup).not.toContain('voice-listening')
	})

	it('shows a plain message with what was heard and a way to dismiss it', () => {
		const markup = status(
			voice({
				notice: { kind: 'info', text: 'A question is waiting on the screen.', heard: 'Evet' },
			}),
		)
		expect(markup).toContain('A question is waiting on the screen.')
		expect(markup).toContain('<q>Evet</q>')
		expect(markup).toContain('aria-label="Dismiss"')
		// An output element is a live status region on its own.
		expect(markup).toContain('<output class="voice-notice"')
	})

	it('never shows raw error text, identifiers or stacks', () => {
		const markup = status(
			voice({
				phase: 'listening',
				notice: {
					kind: 'error',
					text: 'Namzu can’t use the microphone. Allow microphone access in Windows settings, then try again.',
				},
			}),
		)
		expect(markup).not.toMatch(/NotAllowedError|at \w+ \(|[0-9a-f]{8}-[0-9a-f]{4}|ECONN/)
	})
})
