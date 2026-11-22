/**
 * `<default home>/schedule/services.json`: the per-user index of installed
 * scheduler services, so a name typed on a command line finds the home it
 * serves. It always lives in the default Namzu home (`~/.namzu`, whatever
 * `NAMZU_HOME` says), so every shell finds the same file.
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readVersioned, writeJsonAtomic } from '../store/atomic.js'
import type { ServicePlatform } from './manifest.js'

export interface ServiceIndexEntry {
	readonly name: string
	/** The NAMZU_HOME this service serves. */
	readonly home: string
	readonly platform: ServicePlatform
	readonly installedAt: string
}

export interface ServiceIndex {
	readonly v: 1
	readonly kind: 'schedule-service-index'
	readonly services: readonly ServiceIndexEntry[]
}

/** The index file for the person whose home directory is `osHome`. */
export function serviceIndexPath(osHome: string = homedir()): string {
	return join(resolve(osHome, '.namzu'), 'schedule', 'services.json')
}

export function readServiceIndex(osHome?: string): readonly ServiceIndexEntry[] {
	const index = readVersioned<ServiceIndex>(serviceIndexPath(osHome), 'schedule-service-index', 1)
	return index?.services ?? []
}

function writeServiceIndex(services: readonly ServiceIndexEntry[], osHome?: string): void {
	const index: ServiceIndex = { v: 1, kind: 'schedule-service-index', services }
	writeJsonAtomic(serviceIndexPath(osHome), index)
}

export function findService(name: string, osHome?: string): ServiceIndexEntry | undefined {
	return readServiceIndex(osHome).find((entry) => entry.name === name)
}

/** The sentence that refuses `name` for `home` when the index maps it elsewhere, else undefined. */
export function nameClash(name: string, home: string, osHome?: string): string | undefined {
	const existing = findService(name, osHome)
	if (!existing || resolve(existing.home) === resolve(home)) return undefined
	return `the service name ${name} already serves ${existing.home}, not ${home}; uninstall that one (namzu schedule service uninstall ${name}) or pick another --name`
}

/** Add the entry, or replace the one of the same name. */
export function recordService(entry: ServiceIndexEntry, osHome?: string): void {
	const others = readServiceIndex(osHome).filter((e) => e.name !== entry.name)
	writeServiceIndex([...others, entry], osHome)
}

/** Drop the entries named in `names` that serve `home`. Nothing is written when none match. */
export function removeServices(names: readonly string[], home: string, osHome?: string): void {
	const all = readServiceIndex(osHome)
	const kept = all.filter((e) => !(names.includes(e.name) && resolve(e.home) === resolve(home)))
	if (kept.length !== all.length) writeServiceIndex(kept, osHome)
}
