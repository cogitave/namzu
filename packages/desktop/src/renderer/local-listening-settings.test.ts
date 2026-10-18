import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { LocalListeningState } from '../shared/local-listening-protocol.js'
import {
	LocalListeningSettingsContent,
	approximateDownload,
	listeningDownloadStatus,
} from './local-listening-settings.js'
import type { LocalListeningControls } from './use-local-listening.js'

function state(over: Partial<LocalListeningState> = {}): LocalListeningState {
	return {
		installation: 'missing',
		engine: 'unloaded',
		device: 'cpu',
		downloadBytes: 1_037_257_645,
		diskBytes: null,
		...over,
	}
}
function controls(over: Partial<LocalListeningControls> = {}): LocalListeningControls {
	return {
		state: state(),
		loading: false,
		busy: false,
		supported: true,
		install: vi.fn(async () => undefined),
		cancelInstall: vi.fn(async () => undefined),
		uninstall: vi.fn(async () => undefined),
		...over,
	}
}
const render = (listening: LocalListeningControls, accepted: boolean | undefined = true) =>
	renderToStaticMarkup(
		createElement(LocalListeningSettingsContent, {
			listening,
			accepted,
			onAcceptedChange: () => {},
			embedded: true,
		}),
	)

describe('the Voice input card', () => {
	it('humanises the download size', () => {
		expect(approximateDownload(1_037_257_645)).toBe('about 1 GB')
		expect(approximateDownload(1_500_000_000)).toBe('about 1.4 GB')
		expect(approximateDownload(300 * 1024 * 1024)).toBe('about 300 MB')
		expect(approximateDownload(0)).toBe('a large file')
	})

	it('not downloaded: says it is Turkish, on this device, about 1 GB, with one Download action', () => {
		const markup = render(controls())
		expect(markup).toContain('<h3>Voice input</h3>')
		expect(markup).toContain('On this device')
		expect(markup).toContain('Available in Turkish for now.')
		expect(markup).toContain('about 1 GB to download, once.')
		expect(markup).toContain('Download voice input')
		expect(markup).not.toContain('Remove voice input')
		expect(markup).not.toContain('Cancel download')
		expect(markup).not.toContain('Let Namzu use the microphone')
	})

	it('downloading: shows progress and a Cancel', () => {
		const markup = render(
			controls({
				state: state({
					installation: 'installing',
					progress: {
						step: 'downloading',
						downloadedBytes: 207_000_000,
						totalBytes: 1_037_257_645,
					},
				}),
			}),
		)
		expect(markup).toContain('<progress')
		expect(markup).toContain('value="207000000"')
		expect(markup).toContain('Downloading · ')
		expect(markup).toContain('Cancel download')
		expect(markup).not.toContain('Download voice input<')
	})

	it('shows each step of the download in words', () => {
		expect(listeningDownloadStatus(state({ progress: { step: 'preparing' } }))).toBe(
			'Getting ready…',
		)
		expect(listeningDownloadStatus(state({ progress: { step: 'checking' } }))).toBe(
			'Checking the download…',
		)
	})

	it('failed: one plain sentence and a way to retry', () => {
		const markup = render(
			controls({
				state: state({
					installation: 'failed',
					error: 'Listening couldn’t be downloaded. Check your connection and try again.',
				}),
			}),
		)
		expect(markup).toContain('role="alert"')
		expect(markup).toContain('Check your connection and try again.')
		expect(markup).toContain('Try the download again')
	})

	it('a failure of an action is shown plainly too', () => {
		expect(render(controls({ error: 'Voice input couldn’t be removed. Try again.' }))).toContain(
			'Voice input couldn’t be removed. Try again.',
		)
	})

	it('ready: Remove (asks first), the microphone switch, and where it lives', () => {
		const markup = render(
			controls({ state: state({ installation: 'ready', diskBytes: 1_037_257_645 }) }),
		)
		expect(markup).toContain('Remove voice input…')
		expect(markup).toContain('Let Namzu use the microphone')
		expect(markup).toContain('aria-checked="true"')
		expect(markup).toContain('Stored on this device')
		expect(markup).not.toContain('Download voice input')
		expect(markup).not.toMatch(/AppData|Roaming|\.onnx/)
	})

	it('the microphone switch reads off until the person agrees', () => {
		const markup = render(controls({ state: state({ installation: 'ready' }) }), false)
		expect(markup).toContain('aria-checked="false"')
	})

	it('loading and unsupported are said plainly', () => {
		expect(render(controls({ loading: true, state: null }))).toContain('Loading voice input…')
		expect(render(controls({ supported: false, state: null }))).toContain(
			'Voice input is unavailable in this app.',
		)
	})
})
