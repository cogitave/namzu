import { dirname, join } from 'node:path'
import type { EngineVersions } from '../shared/engine-delivery-protocol.js'
import { bundledCliEntry } from './bundled-runtime.js'
import type { SpawnSpec } from './host-launcher.js'
import { type DeliveryClock, EngineDelivery } from './kernel/delivery.js'
import { bundledFactsReader, kernelFromInitialize } from './kernel/facts.js'
import { type FetchLike, createFeedFetch } from './kernel/feed-fetch.js'
import { nodeFs } from './kernel/fs.js'
import { KERNEL_CHANNEL, KERNEL_CONTRACT_RANGE, feedBase, trustedKeys } from './kernel/keys.js'
import { createKernelLog } from './kernel/log.js'
import { KernelManager } from './kernel/manager.js'
import { createProbe, createSelfCheck } from './kernel/self-check.js'
import { KernelStore } from './kernel/store.js'
import { isKernelVersion } from './kernel/version.js'
import { REQUIRED_EXTENSIONS } from './required-extensions.js'
import { readRuntimeVersions } from './runtime-versions.js'

/**
 * Builds the engine delivery from what the app knows (section 5). Returns undefined when the
 * feature is off for this build: no signing key is compiled in (and no test key was allowed), or
 * there is no bundled engine to compare with. With nothing returned the app does exactly what it did
 * before engines could be fetched: no request, no folder, no screen.
 */

export interface EngineDeliveryOptions {
	isPackaged: boolean
	resourcesPath: string | undefined
	/** `<userData>`: the engines live in `<userData>/kernel`. */
	userData: string
	env: NodeJS.ProcessEnv
	platform: string
	arch: string
	/** The app's own executable: it runs an engine as node. */
	execPath: string
	clientVersion: string
	fetch: FetchLike
	clock: DeliveryClock
	/** The setting "Keep the engine up to date". */
	enabled: () => boolean
	publish: ConstructorParameters<typeof EngineDelivery>[0]['publish']
	/** Node flags that must precede the engine's entry file. */
	nodeFlags: () => string[]
	/** For tests: replaces the compiled keys. */
	compiledKeys?: Parameters<typeof trustedKeys>[0]['compiled']
	firstCheckDelayMs?: number
	/** For tests: replaces the real feed address. */
	compiledFeed?: string
}

/** Where a development run (never a packaged app) gets a stand-in for the bundled engine. */
export function developmentBundledEntry(
	options: Pick<EngineDeliveryOptions, 'isPackaged' | 'env'>,
	hasTestKey: boolean,
): string | undefined {
	if (options.isPackaged || !hasTestKey) return undefined
	const folder = options.env.NAMZU_KERNEL_TEST_BUNDLED_DIR
	return folder ? join(folder, 'dist', 'bin.js') : undefined
}

export function createEngineDelivery(options: EngineDeliveryOptions): EngineDelivery | undefined {
	const keys = trustedKeys({
		isPackaged: options.isPackaged,
		env: options.env,
		...(options.compiledKeys ? { compiled: options.compiledKeys } : {}),
	})
	if (keys.length === 0) return undefined
	const bundledEntry =
		bundledCliEntry({ isPackaged: options.isPackaged, resourcesPath: options.resourcesPath }) ??
		developmentBundledEntry(options, keys.length > 0)
	if (!bundledEntry) return undefined

	const log = createKernelLog({
		fs: nodeFs,
		path: join(options.userData, 'kernel', 'updates.log'),
		now: options.clock.now,
		hide: [options.userData],
	})
	const store = new KernelStore({
		root: join(options.userData, 'kernel'),
		fs: nodeFs,
		now: options.clock.now,
		log,
	})
	const probe = createProbe({
		program: options.execPath,
		env: options.env,
		requiredExtensions: REQUIRED_EXTENSIONS,
		after: options.clock.after,
		clientVersion: options.clientVersion,
	})
	const manager = new KernelManager({
		store,
		keys,
		bundledEntry,
		bundledFacts: bundledFactsReader({
			fs: nodeFs,
			cliFolder: dirname(dirname(bundledEntry)),
			// An engine folder without kernel.json says what it is when it is asked once.
			ask: async () => {
				const seen = await probe(bundledEntry)
				if (!seen.ok) throw new Error(seen.problem)
				const kernel = kernelFromInitialize(seen.initialize)
				const word = seen.versionOutput.trim().split(/\s+/u).at(-1)
				const commandLine = kernel?.commandLine ?? (isKernelVersion(word) ? word : undefined)
				if (!kernel || !commandLine) throw new Error('the engine did not say what it is')
				return { ...kernel, commandLine }
			},
		}),
		platform: options.platform,
		arch: options.arch,
		contractRange: KERNEL_CONTRACT_RANGE,
		enabled: options.enabled,
		override: () => options.env.NAMZU_DESKTOP_CLI || undefined,
	})
	const feed = feedBase({
		isPackaged: options.isPackaged,
		override: options.env.NAMZU_KERNEL_FEED_URL,
		...(options.compiledFeed ? { compiled: options.compiledFeed } : {}),
	})
	const versionsOf = (entry: string): EngineVersions => {
		const read = readRuntimeVersions(entry)
		return {
			...(read.cliVersion ? { commandLine: read.cliVersion } : {}),
			...(read.sdkVersion ? { engine: read.sdkVersion } : {}),
		}
	}
	const ready = (async () => {
		await store.open()
		await manager.cleanup()
	})().catch((error: unknown) => {
		log('open-failed', { message: error instanceof Error ? error.message : String(error) })
	})
	return new EngineDelivery({
		manager,
		ready,
		channel: KERNEL_CHANNEL,
		feedBase: feed,
		fetch: createFeedFetch({ fetch: options.fetch, after: options.clock.after }),
		selfCheck: createSelfCheck({
			program: options.execPath,
			env: options.env,
			requiredExtensions: REQUIRED_EXTENSIONS,
			after: options.clock.after,
			clientVersion: options.clientVersion,
		}),
		clock: options.clock,
		...(options.firstCheckDelayMs !== undefined
			? { firstCheckDelayMs: options.firstCheckDelayMs }
			: {}),
		bundledVersions: () => versionsOf(bundledEntry),
		versionsOf,
		spec: (entry): SpawnSpec => ({
			program: options.execPath,
			args: [...options.nodeFlags(), entry, 'acp', '--desktop'],
			env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' },
		}),
		publish: options.publish,
		log,
		flushLog: () => log.flush(),
	})
}

/**
 * Adapts a platform `fetch` (the app's network stack) to what the check reads: the body is read
 * through its reader, so no particular stream flavour is needed.
 */
export function webFetch(
	call: (
		url: string,
		init: { headers: Record<string, string>; redirect: 'follow'; signal: AbortSignal },
	) => Promise<Response>,
): FetchLike {
	return async (url, init) => {
		const response = await call(url, init)
		const stream = response.body
		return {
			status: response.status,
			...(response.url ? { url: response.url } : {}),
			body: stream
				? (async function* () {
						const reader = stream.getReader()
						try {
							for (;;) {
								const { done, value } = await reader.read()
								if (done) return
								yield value as Uint8Array
							}
						} finally {
							await reader.cancel().catch(() => undefined)
						}
					})()
				: null,
		}
	}
}
