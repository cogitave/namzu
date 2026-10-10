import { homedir } from 'node:os'

import { PROVIDER_REGISTRY, VENDOR_NAMES } from '../integrations/providers/registry.js'
import type { ProviderId } from '../integrations/providers/registry.js'

/**
 * The words the terminal app uses for its own concepts, in one place.
 *
 * The kernel's names (turn, session, checkpoint, compaction, host, ingress,
 * usage accounting) are developer vocabulary. A person using the app says
 * "reply", "conversation" and "summarising the conversation". Messages that a
 * person reads take their nouns from here, so a concept has one name
 * everywhere and a rename is one edit.
 *
 * Machine-readable output (`--json`, `exec`, the ACP host, logs) keeps the
 * kernel's names; this glossary is for the interactive surface only.
 */
export const TERMS = Object.freeze({
	/** One model answer, with the tool steps inside it. */
	reply: 'reply',
	/** What the kernel calls a session. */
	conversation: 'conversation',
	/** What the kernel calls compaction. */
	summarising: 'summarising the conversation',
	/** This computer, where the kernel says "host". */
	thisComputer: 'on this computer',
	/** How a person starts the app and resumes a conversation. */
	command: 'namzu',
} as const)

/** `1 message`, `2 messages`. Never `message(s)`. */
export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`
}

/** `20s`, `1m 05s`, `2h 03m`. Never milliseconds. */
export function formatSpan(ms: number): string {
	const seconds = Math.max(1, Math.ceil(ms / 1000))
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
	const hours = Math.floor(minutes / 60)
	return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** One figure of a size: a decimal under ten (`7.5`), a whole number from ten up (`48`). */
function figure(value: number): number {
	return value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
}

/** `512 B`, `7.5 KB`, `48 KB`, `1.2 MB`: one format everywhere, with a space. */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`
	const kilobytes = figure(bytes / 1024)
	if (kilobytes < 1024) return `${kilobytes} KB`
	const megabytes = figure(bytes / (1024 * 1024))
	if (megabytes < 1024) return `${megabytes} MB`
	return `${figure(bytes / (1024 * 1024 * 1024))} GB`
}

/** The product name a person knows a provider by, from the provider registry. */
export function productName(providerId: string | undefined): string | undefined {
	const id = providerId?.trim()
	if (!id) return undefined
	const entry = Object.hasOwn(PROVIDER_REGISTRY, id)
		? PROVIDER_REGISTRY[id as ProviderId]
		: undefined
	const full = entry ? VENDOR_NAMES[entry.vendor] : undefined
	if (full) return full.replace(/\s*\(.*\)\s*$/, '')
	return id.charAt(0).toUpperCase() + id.slice(1)
}

/** A path with the home folder written as `~`, so it stays short and private. */
export function homePath(path: string, home: string = homedir()): string {
	const normalized = path.replaceAll('\\', '/')
	const base = home.replaceAll('\\', '/').replace(/\/$/, '')
	if (base && (normalized === base || normalized.startsWith(`${base}/`))) {
		return `~${normalized.slice(base.length)}`
	}
	return path
}

/** The short form of a conversation id, for places where a whole UUID is noise. */
export function shortId(id: string): string {
	return id.length > 8 ? id.slice(0, 8) : id
}
