import { classicWrittenName } from './events.js'
import type { HookModuleScan } from './scan.js'

/** What a hooks module does, in the terms a person is asked about. */
export interface HookModuleSummary {
	/** The module, relative to the plugin. */
	readonly entry: string
	/** The events it hooks and Namzu runs, as the module spells them (`PreToolUse`). */
	readonly events: readonly string[]
	/** It starts programs. */
	readonly runsCommands: boolean
	/** It reads files in the plugin's folder and the project. */
	readonly readsFiles: boolean
	/** It makes network requests. */
	readonly usesNetwork: boolean
	/** It keeps data between sessions in the plugin's data folder. */
	readonly keepsData: boolean
	/** The variables it reads, by name. */
	readonly readsEnvironment: readonly string[]
	/** What it hooks or calls that Namzu has no place for, one line each. */
	readonly notUsed: readonly string[]
	/** Why it is refused and does not load, one line each. */
	readonly refused: readonly string[]
}

/** Read a scan as a summary of what the module does. */
export function summarizeHookModule(scan: HookModuleScan): HookModuleSummary {
	const events = new Set<string>()
	const notUsed: string[] = []
	for (const hook of scan.hooks) {
		for (const event of hook.runs) {
			const written = classicWrittenName(event)
			if (written !== undefined) events.add(written)
		}
		if (hook.notUsed !== undefined) notUsed.push(hook.notUsed)
	}
	const supportedCalls = scan.calls.filter((call) => call.supported).map((call) => call.call)
	for (const call of scan.calls) {
		if (!call.supported) notUsed.push(`${call.call} is not available in Namzu; calling it throws.`)
	}
	const uses = (prefix: string): boolean => supportedCalls.some((call) => call.startsWith(prefix))
	return {
		entry: scan.entry,
		events: [...events].sort(),
		runsCommands: uses('$.process.'),
		readsFiles: uses('$.fs.'),
		usesNetwork: uses('$.http.'),
		keepsData: uses('$.store.'),
		readsEnvironment: scan.envNames,
		notUsed: [...new Set(notUsed)],
		refused: scan.refusals.map((refusal) => `${refusal.file}:${refusal.line}: ${refusal.message}`),
	}
}

/** One line per thing a person is told about before a module is allowed to run. */
export function hookModuleConsentLines(summary: HookModuleSummary): string[] {
	const lines: string[] = []
	lines.push(
		summary.events.length > 0
			? `hooks ${summary.events.join(', ')}`
			: 'hooks no event that Namzu runs',
	)
	if (summary.runsCommands) lines.push('runs commands')
	if (summary.readsFiles) lines.push('reads files in the plugin and the project')
	if (summary.usesNetwork) lines.push('uses the network')
	if (summary.keepsData) lines.push("keeps data in the plugin's data folder")
	if (summary.readsEnvironment.length > 0) {
		lines.push(`reads environment variables ${summary.readsEnvironment.join(', ')}`)
	}
	return lines
}

/**
 * The entry a consent surface (the trust screen, an install prompt) shows for a
 * plugin's hooks module: who ships it, which file, and what it does.
 */
export interface HookModuleConsentEntry {
	readonly plugin: string
	readonly module: string
	/** What the module does, one line each, ready to show. */
	readonly lines: readonly string[]
	readonly summary: HookModuleSummary
}

export function hookModuleConsentEntry(
	plugin: string,
	scan: HookModuleScan,
): HookModuleConsentEntry {
	const summary = summarizeHookModule(scan)
	return { plugin, module: scan.entry, lines: hookModuleConsentLines(summary), summary }
}
