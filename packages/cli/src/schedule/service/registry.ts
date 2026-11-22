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

function wellFormed(entry: unknown): entry is ServiceIndexEntry {
	if (typeof entry !== 'object' || entry === null) return false
	const e = entry as Record<string, unknown>
	return (
		typeof e.name === 'string' &&
		e.name.length > 0 &&
		typeof e.home === 'string' &&
		e.home.length > 0 &&
		typeof e.platform === 'string'
	)
}

export interface ServiceIndexRead {
	/** The well-formed entries; empty when the file could not be read. */
	readonly services: readonly ServiceIndexEntry[]
	/** One plain sentence when the file exists but cannot be used; the file is then never rewritten. */
	readonly problem?: string
}

/** Read the index without ever throwing: a damaged or newer file is reported in `problem`. */
export function readServiceIndexChecked(osHome?: string): ServiceIndexRead {
	const path = serviceIndexPath(osHome)
	try {
		const index = readVersioned<ServiceIndex>(path, 'schedule-service-index', 1)
		const raw: unknown = index?.services
		const services = Array.isArray(raw) ? raw.filter(wellFormed) : []
		return { services }
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		return {
			services: [],
			problem: `the service index ${path} cannot be read: ${reason}; fix or move it`,
		}
	}
}

export function readServiceIndex(osHome?: string): readonly ServiceIndexEntry[] {
	return readServiceIndexChecked(osHome).services
}

function writeServiceIndex(
	services: readonly ServiceIndexEntry[],
	osHome?: string,
): string | undefined {
	const index: ServiceIndex = { v: 1, kind: 'schedule-service-index', services }
	try {
		writeJsonAtomic(serviceIndexPath(osHome), index)
	} catch (error) {
		return `the service index ${serviceIndexPath(osHome)} could not be written: ${error instanceof Error ? error.message : String(error)}`
	}
	return undefined
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

/**
 * Add the entry, replacing any of the same name and any other name for the
 * same home (one home has one service). Returns a sentence when the index
 * could not be used or written; an unreadable file is left as it was.
 */
export function recordService(entry: ServiceIndexEntry, osHome?: string): string | undefined {
	const read = readServiceIndexChecked(osHome)
	if (read.problem) return read.problem
	const home = resolve(entry.home)
	const others = read.services.filter((e) => e.name !== entry.name && resolve(e.home) !== home)
	return writeServiceIndex([...others, entry], osHome)
}

/**
 * Drop the entries named in `names` that serve `home`. Nothing is written
 * when none match. Best effort: returns a sentence on failure, never throws.
 */
export function removeServices(
	names: readonly string[],
	home: string,
	osHome?: string,
): string | undefined {
	const read = readServiceIndexChecked(osHome)
	if (read.problem) return read.problem
	const kept = read.services.filter(
		(e) => !(names.includes(e.name) && resolve(e.home) === resolve(home)),
	)
	if (kept.length === read.services.length) return undefined
	return writeServiceIndex(kept, osHome)
}
