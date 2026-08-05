/**
 * `namzu run "<prompt>"` — headless one-shot. Runs a single prompt through
 * the same agent the TUI uses and prints the reply to stdout, for scripts
 * and CI. The prompt comes from
 * the arguments, or from stdin when piped. Status lines go to stderr (info,
 * suppressed by `--quiet`); only the answer hits stdout.
 *
 * Non-interactive, so there's no approval prompt — tools auto-run, but the
 * safety gate still hard-denies catastrophic commands. One-shots use an
 * ephemeral session and are not added to `/resume` history.
 *
 * Options are parsed, not spoken: this command joined every argument into the
 * prompt, so the flags its streaming sibling accepts — `--cwd` above all —
 * were read aloud to the model while the run used this directory anyway. Both
 * commands now share one parser (`./run-flags.js`), because they are the same
 * one-shot differing only in how they print.
 */

import { configureLogger } from '@namzu/sdk'
import type { StopReason } from '@namzu/sdk'

import { EXIT_USAGE } from '../exit-codes.js'
import type { DetectedProvider, Preferences, ProviderId } from '../integrations/providers/index.js'
import {
	loadSkillsContext,
	parseRunFlags,
	resolveWorkingDirectory,
	unknownOptionMessage,
} from './run-flags.js'
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
	help: [
		'Usage: namzu run [options] <prompt...>',
		'       echo "<prompt>" | namzu run',
		'',
		'Run a single prompt headlessly and print the reply. Everything that is',
		'not an option is the prompt; when none is given it is read from stdin,',
		'so this composes with a pipe.',
		'',
		'Options (the same ones run-stream takes):',
		'  --cwd <path>          Directory the agent works in (default: this one)',
		'  --provider <id>       Provider to answer with',
		'  --model <id>          Model to answer with',
		'  --skills <a,b,c>      Load these skills as context for the turn',
		'  --                    End of options; the rest is the prompt verbatim',
		'',
		'Tools run without asking, because there is nobody to ask — the safety',
		'gate still refuses catastrophic commands. `--yolo` is accepted and does',
		'nothing here for the same reason.',
		'',
		'Needs a provider. Set a credential in the environment, or run namzu',
		'once to pick one interactively.',
		'',
		'Exit codes: 0 on a reply, 1 on a failed or unfinished run, 2 when no',
		'prompt was supplied, 64 when an argument is wrong.',
	].join('\n'),
	handler: async ({ ctx, rawArgs }) => {
		const flags = parseRunFlags(rawArgs)
		if (flags.unknown.length > 0) {
			// A shell caller learns about a bad argument from `$?`, so this is 64
			// rather than the in-band error event the streaming sibling emits.
			ctx.formatter.error({ message: unknownOptionMessage(flags.unknown) })
			return EXIT_USAGE
		}
		let prompt = flags.rest.join(' ').trim()
		if (!prompt) prompt = (await readStdin()).trim()
		if (!prompt) {
			ctx.formatter.error({ message: 'no prompt — pass it as an argument or pipe it via stdin' })
			return 2
		}
		const resolved = resolveWorkingDirectory(flags.cwd)
		if ('error' in resolved) {
			ctx.formatter.error({ message: resolved.error })
			return EXIT_USAGE
		}

		configureLogger({ level: 'silent' })
		const { probeAgentSession, createAgentSession } = await import('../tui/agent.js')
		const probe = await probeAgentSession()
		let prefs = probe.preferences ?? defaultPrefs(probe.detected)
		if (!prefs) {
			ctx.formatter.error({
				message:
					'no LLM provider available — set a credential (e.g. ANTHROPIC_API_KEY) or run `namzu` to pick one',
			})
			return 1
		}
		if (flags.provider) prefs = { ...prefs, provider: flags.provider as ProviderId }
		if (flags.model) prefs = { ...prefs, model: flags.model }

		const session = await createAgentSession(prefs, probe.detected, { cwd: resolved.cwd })
		if (!session.hasProvider) {
			ctx.formatter.error({ message: session.errorHint ?? 'agent is not ready' })
			return 1
		}
		ctx.formatter.info(
			`namzu · ${session.providerSummary}${session.modelSummary ? ` · ${session.modelSummary}` : ''}`,
		)

		const extraSystem = await loadSkillsContext(resolved.cwd, flags.skills)

		let text = ''
		let failed: string | null = null
		let stopReason: StopReason | undefined
		for await (const event of session.send(
			[{ role: 'user', content: prompt, timestamp: Date.now() }],
			extraSystem ? { extraSystem } : undefined,
		)) {
			if (event.kind === 'delta') text += event.text
			else if (event.kind === 'tool-start')
				ctx.formatter.info(`⏺ ${event.toolName} ${event.summary}`)
			else if (event.kind === 'error') failed = event.message
			else if (event.kind === 'done') stopReason = event.stopReason
		}

		if (failed) {
			ctx.formatter.error({ message: failed })
			return 1
		}

		// The text prints either way. Partial output is real output, and a
		// caller who piped it wants what there is — but `$?` has to be able to
		// tell them it is partial, which it could not: `run_failed` is emitted
		// only from the throw path, so a run stopped by its token budget, its
		// timeout, its iteration cap, a cancellation, or a blocking output
		// guardrail all arrived as `run_completed` and exited 0. Measured: a
		// `max_iterations` stop reports `status: 'completed'`. The sharp case is
		// the guardrail — a REFUSED answer exited 0 with empty text, so
		// `namzu run … > out.txt && deploy` proceeded on the empty file.
		ctx.formatter.print(ctx.formatter.name === 'json' ? { text: text.trim() } : text.trim())
		if (stopReason && stopReason !== 'end_turn') {
			ctx.formatter.error({
				message: `run did not finish normally: ${stopReason}${text.trim() ? ' — the output above is partial' : ''}`,
			})
			return 1
		}
		return 0
	},
}
