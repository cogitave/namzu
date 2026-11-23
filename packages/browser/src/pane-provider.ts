import type { Browser, BrowserContext } from 'playwright-core'
import {
	type BrowserContextProvider,
	type OpenedBrowserContext,
	type ProviderServices,
	firstLine,
	quoteShort,
} from './context-providers.js'
import { BrowserUnavailableError } from './errors.js'
import type { PaneChannel } from './pane-channel.js'
import { type PaneTransportOptions, createPaneTransport } from './pane-transport.js'

export interface PaneProviderOptions extends PaneTransportOptions {
	/** Where Playwright keeps browser artifacts. Default: none are kept. */
	readonly artifactsDir?: string
	/** How long connecting may take. Default 30 000. */
	readonly connectTimeoutMs?: number
}

/**
 * The tabs of an app's browser pane as one browser context. Connects
 * Playwright to a {@link PaneChannel} through {@link createPaneTransport} and
 * returns the default context. The embedder (the app that owns the pane)
 * enforces landing rules as well, so `policy` is `external`.
 */
export class PaneProvider implements BrowserContextProvider {
	readonly id = 'pane'

	constructor(
		private readonly channel: PaneChannel,
		private readonly options: PaneProviderOptions = {},
	) {}

	async open(services?: ProviderServices): Promise<OpenedBrowserContext> {
		const { chromium } = await import('playwright-core')
		const transport = createPaneTransport(this.channel, this.options)
		let browser: Browser
		try {
			browser = await chromium.connectOverCDP(transport, {
				noDefaults: true,
				timeout: this.options.connectTimeoutMs ?? 30_000,
				...(this.options.artifactsDir ? { artifactsDir: this.options.artifactsDir } : {}),
			})
		} catch (error) {
			transport.close()
			throw new BrowserUnavailableError(`The browser pane could not be driven: ${firstLine(error)}`)
		}
		const context: BrowserContext | undefined = browser.contexts()[0]
		if (!context) {
			await browser.close().catch(() => undefined)
			throw new BrowserUnavailableError('The browser pane offered no tab to drive.')
		}
		const channel = this.channel
		const stopListening = channel.onDownloadRefused?.((name) => {
			services?.note(
				`A download of ${quoteShort(name)} was cancelled: the browser does not download files.`,
			)
		})
		return {
			context,
			policy: 'external',
			connection: {
				// Leaving the pane means letting go of its tabs; they stay open for the person.
				detach: async () => {
					stopListening?.()
					await browser.close().catch(() => undefined)
				},
				close: async () => {
					stopListening?.()
					await browser.close().catch(() => undefined)
					await channel.close().catch(() => undefined)
				},
			},
		}
	}
}

/** A provider for the host over a pane channel. */
export function createPaneProvider(
	channel: PaneChannel,
	options: PaneProviderOptions = {},
): PaneProvider {
	return new PaneProvider(channel, options)
}
