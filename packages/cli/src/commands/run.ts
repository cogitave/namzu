/**
 * `namzu run "<prompt>"` — headless one-shot. Runs a single prompt through
 * the same agent the TUI uses and prints the reply to stdout, for scripts
 * and CI (the equivalent of claude-code's `--print`). The prompt comes from
 * the arguments, or from stdin when piped. Status lines go to stderr (info,
 * suppressed by `--quiet`); only the answer hits stdout.
 *
 * Non-interactive, so there's no approval prompt — tools auto-run, but the
 * safety gate still hard-denies catastrophic commands. One-shots use an
 * ephemeral session and are not added to `/resume` history.
 */

import { configureLogger } from '@namzu/sdk'

import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'
import type { CommandDef } from './types.js'

async function readStdin(): Promise<string> {
	if (process.stdin.isTTY) return ''
	const chunks: Buffer[] = []
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
	return Buffer.concat(chunks).toString('utf8')
}

function defaultPrefs(detected: readonly DetectedProvider[]): Preferences | null {
	const first = detected[0]
	return first ? { version: 2, provider: first.entry.id, subagents: { active: [] } } : null
}

export const runCommand: CommandDef = {
	name: 'run',
	description: 'Run a single prompt headlessly and print the reply (for scripts/CI)',
	passThrough: true,
	handler: async ({ ctx, rawArgs }) => {
		let prompt = rawArgs.join(' ').trim()
		if (!prompt) prompt = (await readStdin()).trim()
		if (!prompt) {
			ctx.formatter.error({ message: 'no prompt — pass it as an argument or pipe it via stdin' })
			return 2
		}

		configureLogger({ level: 'silent' })
		const { probeAgentSession, createAgentSession } = await import('../tui/agent.js')
		const probe = await probeAgentSession()
		const prefs = probe.preferences ?? defaultPrefs(probe.detected)
		if (!prefs) {
			ctx.formatter.error({
				message:
					'no LLM provider available — set a credential (e.g. ANTHROPIC_API_KEY) or run `namzu` to pick one',
			})
			return 1
		}

		const session = await createAgentSession(prefs, probe.detected)
		if (!session.hasProvider) {
			ctx.formatter.error({ message: session.errorHint ?? 'agent is not ready' })
			return 1
		}
		ctx.formatter.info(
			`namzu · ${session.providerSummary}${session.modelSummary ? ` · ${session.modelSummary}` : ''}`,
		)

		let text = ''
		let failed: string | null = null
		for await (const event of session.send([
			{ role: 'user', content: prompt, timestamp: Date.now() },
		])) {
			if (event.kind === 'delta') text += event.text
			else if (event.kind === 'tool-start')
				ctx.formatter.info(`⏺ ${event.toolName} ${event.summary}`)
			else if (event.kind === 'error') failed = event.message
		}

		if (failed) {
			ctx.formatter.error({ message: failed })
			return 1
		}
		ctx.formatter.print(ctx.formatter.name === 'json' ? { text: text.trim() } : text.trim())
		return 0
	},
}
