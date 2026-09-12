import { randomBytes } from 'node:crypto'
import type { Dir } from 'node:fs'
import { lstat, opendir } from 'node:fs/promises'
import { isEntityId } from '@namzu/sdk'

const PAGE_ENTRIES = 100
const MAX_STREAMS = 32
const MAX_PAGES = 128
const TTL_MS = 10 * 60_000

interface DiscoveryPage {
	runIds: string[]
	next?: string
}
interface DirectoryStream {
	scope: string
	path: string
	stamp: string
	directory: Dir
	closed: boolean
	expires: number
	timer: ReturnType<typeof setTimeout>
}
interface PageSlot {
	stream: DirectoryStream
	page?: DiscoveryPage
}

/** Process-local, bounded directory continuations. No output or authorization is cached here. */
export class RunDiscovery {
	private streams = new Set<DirectoryStream>()
	private pages = new Map<string, PageSlot>()
	private tail: Promise<void> = Promise.resolve()
	constructor(private readonly now: () => number = Date.now) {}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.tail.then(operation)
		this.tail = next.then(
			() => {},
			() => {},
		)
		return next
	}

	private async stamp(path: string): Promise<string> {
		const stat = await lstat(path)
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid run directory.')
		return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
	}

	private async close(stream: DirectoryStream): Promise<void> {
		if (stream.closed) return
		await stream.directory.close()
		stream.closed = true
	}

	private async forget(stream: DirectoryStream): Promise<void> {
		clearTimeout(stream.timer)
		await this.close(stream)
		this.streams.delete(stream)
		for (const [token, slot] of this.pages) if (slot.stream === stream) this.pages.delete(token)
	}

	private slot(stream: DirectoryStream): string {
		while (this.pages.size >= MAX_PAGES) {
			const oldest = this.pages.keys().next().value
			if (oldest === undefined) throw new Error('Missing discovery page.')
			this.pages.delete(oldest)
		}
		const token = randomBytes(24).toString('hex')
		this.pages.set(token, { stream })
		return token
	}

	/** The host checks ancestor paths and conversation membership before every call. */
	read(scope: string, path: string, cursor?: string, signal?: AbortSignal): Promise<DiscoveryPage> {
		return this.serialize(async () => {
			signal?.throwIfAborted()
			for (const stream of this.streams) if (stream.expires <= this.now()) await this.forget(stream)
			let slot: PageSlot
			if (cursor) {
				const found = this.pages.get(cursor)
				if (!found) throw new Error('Run discovery expired or was evicted; restart the search.')
				if (found.stream.scope !== scope || found.stream.path !== path)
					throw new Error('Run discovery scope changed.')
				slot = found
			} else {
				while (this.streams.size >= MAX_STREAMS) {
					const oldest = this.streams.values().next().value
					if (!oldest) throw new Error('Missing discovery stream.')
					await this.forget(oldest)
				}
				const stamp = await this.stamp(path)
				const directory = await opendir(path, { bufferSize: PAGE_ENTRIES })
				const stream: DirectoryStream = {
					scope,
					path,
					stamp,
					directory,
					closed: false,
					expires: this.now() + TTL_MS,
					timer: setTimeout(() => {
						void this.releaseStream(stream).catch(() => {})
					}, TTL_MS),
				}
				stream.timer.unref()
				this.streams.add(stream)
				slot = { stream }
			}
			const { stream } = slot
			try {
				if ((await this.stamp(path)) !== stream.stamp)
					throw new Error('Run directory changed; restart the search.')
				signal?.throwIfAborted()
				if (slot.page) return structuredClone(slot.page)
				const runIds: string[] = []
				let exhausted = false
				for (let i = 0; i < PAGE_ENTRIES; i++) {
					signal?.throwIfAborted()
					const entry = await stream.directory.read()
					if (!entry) {
						exhausted = true
						break
					}
					if (isEntityId(entry.name, 'run')) runIds.push(entry.name)
				}
				signal?.throwIfAborted()
				if ((await this.stamp(path)) !== stream.stamp)
					throw new Error('Run directory changed; restart the search.')
				signal?.throwIfAborted()
				if (exhausted) await this.close(stream)
				if (exhausted && !cursor) await this.forget(stream)
				const page = { runIds: runIds.sort(), ...(exhausted ? {} : { next: this.slot(stream) }) }
				slot.page = page
				return structuredClone(page)
			} catch (error) {
				await this.forget(stream)
				throw error
			}
		})
	}

	private releaseStream(stream: DirectoryStream): Promise<void> {
		return this.serialize(() => this.forget(stream))
	}

	/** Closing a conversation (or a test host) releases its directory handles and tokens. */
	release(scope?: string): Promise<void> {
		return this.serialize(async () => {
			for (const stream of this.streams)
				if (scope === undefined || stream.scope === scope) await this.forget(stream)
		})
	}
}
