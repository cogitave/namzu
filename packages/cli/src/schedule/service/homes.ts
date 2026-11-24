/**
 * Every scheduler home a person can see from one place: the current home and
 * the home of each installed scheduler service (the index behind
 * `namzu schedule service list`). `schedule list`, a job command typed
 * without `--service`, and the TUI's /schedule all go through here, so a job
 * run by a service is found without naming the service first.
 *
 * Only the `schedule/jobs` and `schedule/state` folders are ever read. A
 * service's `daemon.env` and its other secrets are not opened.
 */

import { constants, accessSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { type SchedulePaths, schedulePaths } from '../paths.js'
import { ScheduleJobNotFoundError, findJob } from '../store/jobs.js'
import type { ScheduleJob } from '../types.js'
import {
	type ServiceIndexEntry,
	displayName,
	matchService,
	readServiceIndexChecked,
} from './registry.js'

export interface ScheduleHome {
	/** The service's name; absent for the current home. */
	readonly service?: string
	readonly home: string
	readonly paths: SchedulePaths
	/** One plain sentence when the home cannot be listed. */
	readonly unreadable?: string
	readonly entry?: ServiceIndexEntry
}

/** Why a folder cannot be listed, or undefined when it can (or has no schedule yet). */
function whyUnreadable(home: string): string | undefined {
	try {
		if (!statSync(home).isDirectory()) return `${home} is not a folder`
	} catch {
		return `${home} does not exist`
	}
	try {
		accessSync(home, constants.R_OK | constants.X_OK)
		const root = schedulePaths(home).root
		try {
			accessSync(root, constants.R_OK | constants.X_OK)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
			throw error
		}
	} catch {
		return `no permission to read ${home}`
	}
	return undefined
}

export interface ScheduleHomes {
	/** The current home first, then one entry per installed service that serves another home. */
	readonly homes: readonly ScheduleHome[]
	/** The service index could not be read: a sentence, and `homes` holds the current home only. */
	readonly indexProblem?: string
}

export function scheduleHomes(currentHome: string): ScheduleHomes {
	const current = resolve(currentHome)
	const index = readServiceIndexChecked()
	const seen = new Set<string>([current])
	const others: ScheduleHome[] = []
	// Two entries that show the same name (a legacy `x-wsl-<distro>` and `x`)
	// are told apart by their exact registered names, so `--service` can pick one.
	const shown = new Map<string, number>()
	for (const entry of index.services) {
		const name = displayName(entry)
		shown.set(name, (shown.get(name) ?? 0) + 1)
	}
	for (const entry of index.services) {
		const home = resolve(entry.home)
		if (seen.has(home)) continue
		seen.add(home)
		const unreadable = whyUnreadable(home)
		others.push({
			service: (shown.get(displayName(entry)) ?? 0) > 1 ? entry.name : displayName(entry),
			home,
			paths: schedulePaths(home),
			entry,
			...(unreadable ? { unreadable } : {}),
		})
	}
	return {
		homes: [{ home: current, paths: schedulePaths(current) }, ...others],
		...(index.problem ? { indexProblem: index.problem } : {}),
	}
}

export type JobLocation =
	| { readonly kind: 'found'; readonly job: ScheduleJob; readonly at: ScheduleHome }
	| { readonly kind: 'several'; readonly at: readonly ScheduleHome[] }
	| { readonly kind: 'no-service'; readonly name: string; readonly known: readonly string[] }
	| { readonly kind: 'none' }

/** The words that name a home in a message. */
export function homeWords(at: ScheduleHome): string {
	return at.service ? `the service ${at.service}` : 'this home'
}

/**
 * Find a job by name (or id prefix) in the current home and every service's
 * home. With `service`, only that service; with `null`, only the current home. A match in exactly one home is
 * returned; several are reported, none is `none`. A real problem in the
 * current home (an ambiguous name, an unreadable file) is thrown, as
 * `findJob` throws it. A service home that cannot be read is skipped.
 */
export function locateJob(ref: string, currentHome: string, service?: string | null): JobLocation {
	if (service === null) {
		const current = scheduleHomes(currentHome).homes[0] as ScheduleHome
		return { kind: 'found', job: findJob(current.paths, ref), at: current }
	}
	const all = scheduleHomes(currentHome)
	if (service !== undefined) {
		const entry = matchService(readServiceIndexChecked().services, service)
		const home = entry
			? all.homes.find((h) => h.service !== undefined && h.home === resolve(entry.home))
			: undefined
		const target =
			home ?? (entry && resolve(entry.home) === resolve(currentHome) ? all.homes[0] : undefined)
		if (!target)
			return {
				kind: 'no-service',
				name: service,
				known: all.homes.flatMap((h) => (h.service ? [h.service] : [])),
			}
		if (target.unreadable)
			throw new Error(`cannot read the service ${service}: ${target.unreadable}`)
		return { kind: 'found', job: findJob(target.paths, ref), at: target }
	}
	const current = all.homes[0] as ScheduleHome
	const found: { job: ScheduleJob; at: ScheduleHome }[] = []
	let currentError: unknown
	try {
		found.push({ job: findJob(current.paths, ref), at: current })
	} catch (error) {
		if (!(error instanceof ScheduleJobNotFoundError)) currentError = error
	}
	for (const at of all.homes.slice(1)) {
		if (at.unreadable) continue
		try {
			found.push({ job: findJob(at.paths, ref), at })
		} catch {
			// not here, or a file there that cannot be read: not this home's job to act on
		}
	}
	// An ambiguous or unreadable reference here is never settled by another home.
	if (currentError) throw currentError
	if (found.length === 1) return { kind: 'found', ...(found[0] as (typeof found)[number]) }
	if (found.length > 1) return { kind: 'several', at: found.map((f) => f.at) }
	return { kind: 'none' }
}

/** The one line that refuses a name found in several homes. */
export function severalLine(ref: string, at: readonly ScheduleHome[]): string {
	const names = at.map((h) => (h.service ? h.service : 'this home')).join(', ')
	const forms = at
		.map((h) => (h.service ? `--service ${h.service}` : `--home ${h.home}`))
		.join(' or ')
	return `"${ref}" is a job in more than one scheduler home (${names}); say which with ${forms}`
}
