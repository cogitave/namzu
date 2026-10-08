import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
	DEFAULT_LOCAL_SPEECH_SETTINGS,
	LOCAL_SPEECH_MODEL_BYTES,
	type LocalSpeechState,
} from '../shared/local-speech-protocol.js'
import {
	LocalSpeechReadAloud,
	LocalSpeechResourceCard,
	LocalSpeechSettingsContent,
	formatSpeechBytes,
} from './local-speech-settings.js'
import type { LocalSpeechControls } from './use-local-speech.js'

function state(): LocalSpeechState {
	return {
		settings: { ...DEFAULT_LOCAL_SPEECH_SETTINGS },
		installation: 'missing',
		worker: 'unloaded',
		device: 'cpu',
		resources: {
			modelDownloadBytes: LOCAL_SPEECH_MODEL_BYTES,
			runtimeDownloadBytes: null,
			diskBytes: null,
			ramBytes: null,
			cpuPercent: null,
			vramBytes: null,
			firstAudioMs: null,
			measuredAt: null,
		},
	}
}

function controls(overrides: Partial<LocalSpeechControls> = {}): LocalSpeechControls {
	return {
		state: state(),
		supported: true,
		loading: false,
		busy: false,
		configure: vi.fn(),
		install: vi.fn(),
		uninstall: vi.fn(),
		preview: vi.fn(),
		readAloud: vi.fn(),
		stop: vi.fn(),
		...overrides,
	}
}

describe('local speech settings display', () => {
	it('separates the known model download from unknown engine, RAM and first audio', () => {
		const html = renderToStaticMarkup(
			createElement(LocalSpeechResourceCard, { state: state(), showDetails: true }),
		)
		expect(html).toContain('32.8 MiB')
		expect(html).toMatch(/Voice engine download<\/dt><dd>Not measured/)
		expect(html).toMatch(/Total installed size<\/dt><dd>Not measured/)
		expect(html).toMatch(/Voice memory · RAM<\/dt><dd>Not measured/)
		expect(html).toMatch(/First audio<\/dt><dd>Not measured/)
		expect(html).toMatch(/GPU memory · VRAM<\/dt><dd>Not used/)
	})

	it('displays actual measurements including a genuine zero CPU measurement', () => {
		const view = state()
		view.resources = {
			...view.resources,
			runtimeDownloadBytes: 100_000_000,
			diskBytes: 300_000_000,
			ramBytes: 250_000_000,
			cpuPercent: 0,
			firstAudioMs: 217,
			measuredAt: '2026-10-07T10:00:00.000Z',
		}
		const html = renderToStaticMarkup(
			createElement(LocalSpeechResourceCard, { state: view, showDetails: true }),
		)
		expect(html).toContain('286.1 MiB')
		expect(html).toContain('238.4 MiB')
		expect(html).toMatch(/CPU use<\/dt><dd>0%/)
		expect(html).toContain('217 ms')
	})

	it('shows a Turkish language choice and explicit download before using speech', () => {
		const html = renderToStaticMarkup(
			createElement(LocalSpeechSettingsContent, { speech: controls() }),
		)
		expect(html).toContain('Speech language')
		expect(html).toContain('Türkçe')
		expect(html).toContain('EMA Lightning')
		expect(html).toContain('Download voice')
		expect(html).toContain('Free memory when idle')
		expect(html).not.toContain('Preview voice')
	})

	it('does not offer read aloud until voice is explicitly enabled', () => {
		const html = renderToStaticMarkup(
			createElement(LocalSpeechReadAloud, {
				speech: controls(),
				messageId: 'reply-1',
				text: 'Merhaba.',
			}),
		)
		expect(html).toBe('')
		const view = state()
		view.settings.enabled = true
		view.installation = 'ready'
		const ready = renderToStaticMarkup(
			createElement(LocalSpeechReadAloud, {
				speech: controls({ state: view }),
				messageId: 'reply-1',
				text: 'Merhaba.',
			}),
		)
		expect(ready).toContain('aria-label="Read aloud"')
		expect(ready).not.toContain(' disabled=""')
		const playing = renderToStaticMarkup(
			createElement(LocalSpeechReadAloud, {
				speech: controls({ state: view, playingMessageId: 'reply-1' }),
				messageId: 'reply-1',
				text: 'Merhaba.',
			}),
		)
		expect(playing).toContain('aria-label="Stop reading aloud"')
		expect(playing).toContain('aria-pressed="true"')
	})

	it('cannot present an unavailable runtime as ready or claim the entire chat is offline', () => {
		const html = renderToStaticMarkup(
			createElement(LocalSpeechSettingsContent, {
				speech: controls({ supported: false, state: null }),
			}),
		)
		expect(html).toContain('Local speech is unavailable in this runtime.')
		expect(html).not.toContain('Ready')
		expect(html).not.toMatch(/chat.*offline/i)
	})

	it('does not turn invalid or unknown byte measurements into zeroes', () => {
		expect(formatSpeechBytes(null)).toBe('Not measured')
		expect(formatSpeechBytes(Number.NaN)).toBe('Not measured')
		expect(formatSpeechBytes(-1)).toBe('Not measured')
		expect(formatSpeechBytes(0)).toBe('0 B')
	})
})
