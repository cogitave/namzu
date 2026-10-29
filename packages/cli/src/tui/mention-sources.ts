/**
 * What the `@` picker offers besides files: the sub-agents a session can hand
 * work to and the resources its connected tool servers publish. Loaded when a
 * session comes up and again as tool servers connect, so the composer never
 * waits on either.
 */

import type { McpResourceListing } from '../integrations/mcp/servers.js'
import { discoverAgentDefinitions } from '../integrations/subagents/definitions.js'
import { type KnownMentions, type MentionExtra, agentMention } from './mentions.js'

const DESCRIPTION_CHARS = 60

/** Agents every session has, by the name the model picks them with. */
const BUILT_IN_AGENTS: readonly { readonly name: string; readonly description: string }[] = [
	{ name: 'explore', description: 'Looks through the code and never edits' },
	{ name: 'plan', description: 'Plans a change step by step and never edits' },
]

function shorten(text: string): string {
	const line = (text.split('\n')[0] ?? '').trim()
	return line.length > DESCRIPTION_CHARS ? `${line.slice(0, DESCRIPTION_CHARS - 1)}…` : line
}

export interface MentionSources {
	readonly extras: readonly MentionExtra[]
	/** What a sent message may name, for {@link expandFileMentions}. */
	readonly known: KnownMentions
}

export const NO_MENTION_SOURCES: MentionSources = { extras: [], known: {} }

export function mentionSourcesFrom(
	agents: readonly { readonly name: string; readonly description: string }[],
	resources: readonly McpResourceListing[],
): MentionSources {
	const byName = new Map<string, string>()
	for (const agent of [...BUILT_IN_AGENTS, ...agents]) byName.set(agent.name, agent.description)
	const extras: MentionExtra[] = [
		...resources.map(
			(resource): MentionExtra => ({
				kind: 'resource',
				label: `${resource.server}:${resource.uri}`,
				description: shorten(resource.description || resource.name || resource.uri),
			}),
		),
		...[...byName].map(([name, description]) => ({
			...agentMention(name),
			description: shorten(description),
		})),
	]
	return {
		extras,
		known: {
			agents: new Set(byName.keys()),
			servers: new Set(resources.map((resource) => resource.server)),
		},
	}
}

/**
 * The sub-agents (built in and defined in files) and resources for the
 * picker. A directory of agent files that cannot be read costs the file
 * agents and nothing else.
 */
export async function loadMentionSources(input: {
	readonly cwd: string
	readonly resources?: {
		list(signal?: AbortSignal): Promise<readonly McpResourceListing[]>
	}
	readonly signal?: AbortSignal
}): Promise<MentionSources> {
	const [agents, resources] = await Promise.all([
		discoverAgentDefinitions({ cwd: input.cwd })
			.then((found) => found.definitions)
			.catch(() => []),
		input.resources ? input.resources.list(input.signal).catch(() => []) : Promise.resolve([]),
	])
	return mentionSourcesFrom(agents, resources)
}
