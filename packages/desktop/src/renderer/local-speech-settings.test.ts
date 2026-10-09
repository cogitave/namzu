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
	it('shows the known download size and leaves unmeasured figures out instead of a placeholder', () => {
		const html = renderToStaticMarkup(
			createElement(LocalSpeechResourceCard, { state: state(), showDetails: true }),
		)
		expect(html).toContain('32.8 MiB')
		expect(html).not.toContain('Not measured')
		expect(html).not.toContain('RAM')
		expect(html).not.toContain('VRAM')
		expect(html).not.toContain('worker')
		expect(html).not.toContain('Space used')
		expect(html).not.toContain('More resources')
	})

	it('shows nothing at all when nothing is known', () => {
		const view = state()
		view.resources = { ...view.resources, modelDownloadBytes: Number.NaN }
		expect(renderToStaticMarkup(createElement(LocalSpeechResourceCard, { state: view }))).toBe('')
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
		expect(html).toContain('Space used')
		expect(html).toContain('238.4 MiB')
		expect(html).toMatch(/Processor use<\/dt><dd>0%/)
		expect(html).toContain('217 ms')
	})

	it('before the download says what it does and offers one Download voice action', () => {
		const html = renderToStaticMarkup(
			createElement(LocalSpeechSettingsContent, { speech: controls() }),
		)
		expect(html).toContain('Reads replies aloud in Turkish')
		expect(html).toContain('32.8 MiB to download')
		expect(html).toContain('Download voice')
		expect(html).not.toContain('Enable voice')
		expect(html).not.toContain('Free memory when idle')
		expect(html).not.toContain('Resources')
		expect(html).not.toContain('Not measured')
		expect(html).not.toContain('EMA Lightning')
		expect(html).not.toContain('Preview voice')
	})

	it('after the download offers the language, the switches and a preview, without a raw path', () => {
		const view = state()
		view.installation = 'ready'
		const html = renderToStaticMarkup(
			createElement(LocalSpeechSettingsContent, { speech: controls({ state: view }) }),
		)
		expect(html).toContain('Speech language')
		expect(html).toContain('Türkçe')
		expect(html).toContain('Enable voice')
		expect(html).toContain('Free memory when idle')
		expect(html).toContain('Preview voice')
		expect(html).toContain('Data folders')
		expect(html).not.toContain('Download voice')
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
