import type { Logger } from '@namzu/sdk'

import type { SubagentActivity } from './activity.js'
import {
	type Batch,
	type BatchListing,
	NO_BATCHES_MESSAGE,
	combineBatches,
	liveBatches,
} from './batches.js'

/** The subcommands `/agents` accepts. `runs` is not one of them: it became `batches`, with no alias. */
export const AGENTS_SUBCOMMANDS = ['running', 'available', 'batches'] as const

export type AgentsSubcommand = (typeof AGENTS_SUBCOMMANDS)[number]

/** The one usage line, shown for anything `/agents` does not accept. */
export const AGENTS_USAGE = `/agents [${AGENTS_SUBCOMMANDS.join('|')}]`

/** What `/agents` needs from its host. */
export interface AgentsSlashContext {
	/** The live monitor's current rows. */
	readonly liveAgents: () => readonly SubagentActivity[]
	/**
	 * This conversation's finished batches, read from the session index
	 * (`listSavedBatches`). Absent for a host that keeps no session log, whose
	 * listing is then live-only.
	 */
	readonly savedBatches?: () => Promise<readonly Batch[]>
	/** Clock for a live batch's elapsed time. Defaults to `Date.now`. */
	readonly now?: () => number
	readonly log?: Logger
}

/** What the host does with an `/agents` command. */
export type SlashResult =
	/** Open the agent cockpit on the running work. */
	| { readonly kind: 'agent-cockpit' }
	/** List the agents this session can delegate to. */
	| { readonly kind: 'available-agents' }
	/** Offer these batches to pick from; never empty. */
	| { readonly kind: 'batches'; readonly listing: BatchListing }
	/** Print this system line. */
	| { readonly kind: 'message'; readonly content: string }

/**
 * `/agents [running|available|batches]`.
 *
 * `batches` merges the live monitor's still-running batches with the finished
 * ones the session index holds (see `combineBatches`). Saved state is
 * optional: a host whose index read fails still gets the live half, and the
 * failure is logged rather than shown as "no batches". An empty listing is
 * answered with a line instead of an empty picker.
 *
 * Anything else — `runs` included — prints the usage line.
 */
export async function agentsSlashCommand(
	args: readonly string[],
	ctx: AgentsSlashContext,
): Promise<SlashResult> {
	const [subcommand, ...rest] = args
	if (rest.length > 0) return usage()
	if (subcommand === undefined || subcommand === 'running') return { kind: 'agent-cockpit' }
	if (subcommand === 'available') return { kind: 'available-agents' }
	if (subcommand !== 'batches') return usage()
	const live = liveBatches(ctx.liveAgents(), (ctx.now ?? Date.now)())
	let finished: readonly Batch[] = []
	try {
		finished = (await ctx.savedBatches?.()) ?? []
	} catch (error) {
		ctx.log?.warn('Saved batches could not be read; listing live batches only', {
			'namzu.subagent.batches.error': error instanceof Error ? error.message : String(error),
		})
	}
	const listing = combineBatches(live, finished)
	if (listing.batches.length === 0) return { kind: 'message', content: NO_BATCHES_MESSAGE }
	return { kind: 'batches', listing }
}

function usage(): SlashResult {
	return { kind: 'message', content: `Usage: ${AGENTS_USAGE}` }
}
