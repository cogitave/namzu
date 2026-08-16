import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Where an operator's config overrides survive a process.
 *
 * In `store/` rather than beside the registry, and shaped like its
 * neighbours, because the alternative is a second persistence mechanism in a
 * tree that already has one — and two ways to write durable state is two
 * places to get a path, a permission or an encoding wrong.
 *
 * **Synchronous, deliberately.** `ConfigScope.get()` is read on every
 * reconnect attempt and inside a supervisor's backoff loop, so a config read
 * cannot be a promise without making every consumer async for a value that
 * is already in memory. The store is read ONCE at construction and written
 * through on update, which is what makes that possible.
 */

export interface ConfigOverrideStore {
	/** Everything previously written, keyed by namespace. Read once. */
	load(): Record<string, unknown>
	/** Persist one namespace's accumulated override. */
	save(namespace: string, override: unknown): void
}

/** The default: nothing survives the process, and it says so by its name. */
export class InMemoryConfigOverrideStore implements ConfigOverrideStore {
	private readonly overrides: Record<string, unknown> = {}

	load(): Record<string, unknown> {
		return { ...this.overrides }
	}

	save(namespace: string, override: unknown): void {
		this.overrides[namespace] = override
	}
}

/**
 * One JSON file, rewritten whole on every save.
 *
 * Whole-file rather than append-and-replay: this holds tens of small
 * objects, not a log, and a rewrite is the shape a human can open and read.
 * A corrupt file loads as empty rather than throwing — a config override is
 * a preference, and refusing to start a run because one is unreadable would
 * make a convenience into an outage.
 */
export class DiskConfigOverrideStore implements ConfigOverrideStore {
	private cache: Record<string, unknown> | undefined

	constructor(private readonly path: string) {}

	load(): Record<string, unknown> {
		if (this.cache) return { ...this.cache }
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf-8'))
			this.cache =
				typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
					? (parsed as Record<string, unknown>)
					: {}
		} catch {
			this.cache = {}
		}
		return { ...this.cache }
	}

	save(namespace: string, override: unknown): void {
		const current = this.load()
		current[namespace] = override
		this.cache = current
		mkdirSync(dirname(this.path), { recursive: true })
		writeFileSync(this.path, `${JSON.stringify(current, null, '\t')}\n`, 'utf-8')
	}
}
