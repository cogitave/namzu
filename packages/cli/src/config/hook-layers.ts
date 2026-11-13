/**
 * How the hooks of several config files become the one set a session attaches.
 *
 * Every layer that declares hooks contributes, in the order the layers are
 * given (the resolution order: user file, project file, local file, a selected
 * profile, then the organisation-managed file). For one event the entries of
 * all layers are attached in that order, which is also the order the kernel
 * reads the hooks' answers in: the first refusal quoted is the earliest layer's,
 * and of several rewrites the last layer's wins, so the managed file's word
 * comes last. An entry that reads the same in two layers is attached once, at
 * its first position. Each attached entry carries the file it came from in
 * `source`.
 *
 * Two switches narrow the set. `disableHooks` drops every entry that is not
 * from the managed file. `hooksManagedOnly`, honoured only when the managed
 * file itself sets it, does the same. Neither touches a plugin's JavaScript hooks.
 */

import type { HookEntry, HooksConfig } from './schema.js'

export interface HookLayer {
	/** Where the layer's entries are said to come from: a file, with its profile when it is one. */
	readonly label: string
	/** The layer is the organisation-managed file (or a profile in it). */
	readonly managed: boolean
	readonly hooks?: HooksConfig
}

export interface AssembledHooks {
	/** Absent when nothing is attached. */
	readonly hooks?: HooksConfig
	/** How many entries are attached, by the file they came from. */
	readonly counts: ReadonlyMap<string, number>
	/** Entries left out because a switch was on. */
	readonly switchedOff: number
	/** Entries dropped because an earlier layer already attached the same one. */
	readonly duplicates: number
}

/** What makes two entries "the same": everything but where they were declared. */
export function hookIdentity(event: string, entry: HookEntry): string {
	const { source: _source, ...rest } = entry as HookEntry & { source?: string }
	const normalised: Record<string, unknown> = { ...rest, type: rest.type ?? 'command' }
	// The order a mapping's names were written in does not make a different entry.
	const env = (rest as { env?: Record<string, string> }).env
	if (env !== undefined) {
		normalised.env = Object.fromEntries(
			Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
		)
	}
	const sorted = Object.fromEntries(
		Object.entries(normalised)
			.filter(([, value]) => value !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	)
	return JSON.stringify([event, sorted])
}

export function assembleHooks(
	layers: readonly HookLayer[],
	switches: { readonly disableHooks: boolean; readonly managedOnly: boolean },
): AssembledHooks {
	const limited = switches.disableHooks || switches.managedOnly
	const seen = new Set<string>()
	const out: Record<string, HookEntry[]> = {}
	const counts = new Map<string, number>()
	let switchedOff = 0
	let duplicates = 0
	for (const layer of layers) {
		if (layer.hooks === undefined) continue
		for (const [event, entries] of Object.entries(layer.hooks)) {
			for (const entry of entries ?? []) {
				if (limited && !layer.managed) {
					switchedOff += 1
					continue
				}
				const identity = hookIdentity(event, entry)
				if (seen.has(identity)) {
					duplicates += 1
					continue
				}
				seen.add(identity)
				const list = out[event] ?? []
				list.push({ ...entry, source: layer.label })
				out[event] = list
				counts.set(layer.label, (counts.get(layer.label) ?? 0) + 1)
			}
		}
	}
	return {
		...(Object.keys(out).length > 0 ? { hooks: out as HooksConfig } : {}),
		counts,
		switchedOff,
		duplicates,
	}
}

/**
 * Which switch, if any, is limiting the attached hooks to the managed file's.
 * `managed-only` is the managed file's own statement and outranks the person's
 * `disabled`.
 */
export type HooksSwitch = 'disabled' | 'managed-only'

export function hookSwitch(config: {
	readonly disableHooks?: boolean
	readonly hooksManagedOnly?: boolean
}): HooksSwitch | undefined {
	if (config.hooksManagedOnly === true) return 'managed-only'
	if (config.disableHooks === true) return 'disabled'
	return undefined
}

/** The number of attached hook entries by the file they came from, in first-seen order. */
export function hooksBySource(hooks: HooksConfig | undefined): ReadonlyMap<string, number> {
	const counts = new Map<string, number>()
	for (const entries of Object.values(hooks ?? {})) {
		for (const entry of entries ?? []) {
			const source = entry.source ?? 'unknown'
			counts.set(source, (counts.get(source) ?? 0) + 1)
		}
	}
	return counts
}
