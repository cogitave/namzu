/**
 * Read-only queries a host UI polls alongside `namzu exec --json`: a
 * conversation's persisted messages (`history`), the skills a working
 * directory offers (`skills list --json`) and the providers with their models
 * (`providers list --json`). Each prints one JSON value on stdout and an empty
 * array on any failure.
 */

import { asSessionId, isEntityId, jsonLinesSink } from '@namzu/sdk'

import { isModelOnlyContext } from '../context/runtime-message.js'
import {
	closeSessions,
	findMappedConversation,
	listRecent,
	loadConversation,
	openSessions,
} from '../integrations/sessions/store.js'
import { contextLogging, installCliLogging } from '../logging.js'
import { parseExecFlags, resolveWorkingDirectory } from './exec-flags.js'
import type { CommandContext, CommandDef } from './types.js'

export const historyCommand: CommandDef = {
	name: 'history',
	description: "Print a session's persisted messages as JSON (for host UIs)",
	passThrough: true,
	help: [
		'Usage: namzu history [--session <id>] [--cwd <path>]',
		'',
		"Print a session's persisted messages as JSON. With no session id the",
		'most recent session for the working directory is used.',
		'',
		'An empty array means the session exists and has no messages yet — it',
		'is not an error.',
	].join('\n'),
	handler: async ({ rawArgs }) => {
		const flags = parseExecFlags(rawArgs)
		const key = flags.session

		try {
			// `--cwd` is in this command's help too, and picks the central Project
			// the session is read from. Reading the process's own directory
			// instead means a host asking about a session in another checkout is
			// told `[]` — indistinguishable from a session with no messages.
			const resolved = resolveWorkingDirectory(flags.cwd)
			if ('error' in resolved) {
				process.stdout.write('[]\n')
				return 0
			}
			const cli = await openSessions(resolved.cwd)
			// Host keys and CLI conversation UUIDs are distinct entry points. Both
			// must pass the same workspace membership check before reading content.
			const existing = key
				? ((await findMappedConversation(cli, key)) ??
					(isEntityId(key, 'session') ? asSessionId(key) : null))
				: (await listRecent(cli, 1))[0]?.id
			if (!existing) {
				process.stdout.write('[]\n')
				return 0
			}
			// The fold of the conversation's log: an answer the runtime replaced
			// (a guardrail rewrite) reads as replaced, never as the raw text.
			const messages = await loadConversation(cli, existing).finally(() => closeSessions(cli))
			const out = messages
				.filter(
					(m) =>
						(m.role === 'user' || m.role === 'assistant') && m.content && !isModelOnlyContext(m),
				)
				.map((m) => ({ role: m.role, content: m.content }))
			process.stdout.write(`${JSON.stringify(out)}\n`)
			return 0
		} catch {
			process.stdout.write('[]\n')
			return 0
		}
	},
}

// `skills list --json` — read-only skill discovery for a host UI (the Namzu
// tab's skill chips). Prints the cwd-resolved skills as a JSON array of
// {name, description, source}. Empty array on any failure.
export async function printSkillsJson(
	ctx: CommandContext,
	rawArgs: readonly string[],
): Promise<number> {
	// Project skills live under the working directory, so a host listing the
	// skills for one checkout while the process sits in another was shown
	// the wrong project's chips — and then `exec --json --cwd <that
	// checkout> --skills <name>` could not find the skill it had just
	// offered. Same flag, same directory, both ends.
	const resolved = resolveWorkingDirectory(parseExecFlags(rawArgs).cwd)
	if ('error' in resolved) {
		process.stdout.write('[]\n')
		return 0
	}
	try {
		const { discoverSkills } = await import('../skills/store.js')
		const skills = discoverSkills({
			cwd: resolved.cwd,
			...(ctx.config.skills ? { config: ctx.config.skills } : {}),
		})
			// A disabled skill is not offered: `exec --skills` would skip it.
			.filter((s) => s.disabled !== true)
			.map((s) => ({
				name: s.name,
				description: s.description,
				source: s.source,
			}))
		process.stdout.write(`${JSON.stringify(skills)}\n`)
	} catch {
		process.stdout.write('[]\n')
	}
	return 0
}

export interface ProviderRow {
	provider: string
	label: string
	detected: boolean
	default: string
	models: Array<{ id: string; name: string }>
}

// Provider+model discovery for a host UI (the Namzu tab's provider/model
// pickers) and for `providers list`. Every PROVIDER_REGISTRY entry with
// detection state + a best-effort live model list. Empty models[] → the host
// falls back to a free-text model field seeded with `default`. Never throws;
// returns [] on failure.
export async function collectProviders(ctx: CommandContext): Promise<ProviderRow[]> {
	try {
		// Always NDJSON on stderr — the same reasoning as `exec --json`'s own
		// sink: this command answers a host UI polling for a picker list,
		// not a person reading a terminal.
		const logging = contextLogging(ctx)
		installCliLogging(jsonLinesSink(process.stderr), logging.level)
		const { PROVIDER_REGISTRY, ALL_PROVIDER_IDS, findDetected } = await import(
			'../integrations/providers/index.js'
		)
		const { probeAgentSession, listProviderModels } = await import('../tui/agent.js')
		const probe = await probeAgentSession()
		const out: ProviderRow[] = []
		for (const id of ALL_PROVIDER_IDS) {
			const entry = PROVIDER_REGISTRY[id]
			const det = findDetected(probe.detected, id) ?? null
			const models = det ? await listProviderModels(id, det).catch(() => []) : []
			out.push({
				provider: id,
				label: entry.label,
				detected: Boolean(det),
				default: entry.defaultModel,
				models,
			})
		}
		// Detected providers first, so the picker defaults to a usable one.
		out.sort((a, b) => Number(b.detected) - Number(a.detected))
		return out
	} catch {
		return []
	}
}
