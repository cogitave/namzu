/**
 * What the salience strategy must keep, and what it must not cost.
 *
 * The structured pass chooses what to keep by position, so a fact stated
 * early — the account id, the flag that must not be set — ages out at the
 * same rate as chatter. The salience pass scores every message and keeps
 * what later turns used. This suite states the two claims as scorers over
 * a scripted run with an 8k window: the needle a later turn cited is still
 * in the final history verbatim, and the run stays within a token ceiling
 * the structured strategy does not meet on the same script. Scripted
 * provider, so a score that moves is the kernel moving.
 */
import {
	MockLLMProvider,
	ToolRegistry,
	autoApproveHandler,
	customScorer,
	drainQuery,
	evalRunFromRun,
	runExperiment,
} from '@namzu/sdk'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

const NEEDLE = 'acc_4213'
const BULK = 'filler text that the model has already read and moved past '.repeat(70)

function registry() {
	const tools = new ToolRegistry()
	tools.register({
		name: 'dump',
		description: 'Return a large block of text; the first carries the account id.',
		inputSchema: z.object({ which: z.number() }),
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		execute: async ({ which }) => ({
			success: true,
			// The needle sits DEEP in the body: the stale-result placeholder keeps
			// a head and a tail, so a needle in the first line would survive a
			// clearing pass by accident and prove nothing.
			output:
				which === 0
					? `billing config\n${BULK}\nthe account id is ${NEEDLE}, never bill another.\n${BULK}`
					: `dump ${which}\n${BULK}`,
		}),
	})
	return tools
}

const dump = (i) => ({ toolCalls: [{ id: `d${i}`, name: 'dump', rawArguments: JSON.stringify({ which: i }) }] })

function turns() {
	const script = [dump(0)]
	for (let i = 1; i < 8; i += 1) script.push(dump(i))
	// The citation: a later turn names the id, which is what marks the first
	// dump as used. Then the answer.
	script.push({ text: `I will bill ${NEEDLE} as the config says.` }, dump(8), { text: `done for ${NEEDLE}` })
	return script
}

async function runCase(input) {
	const run = await drainQuery({
		provider: new MockLLMProvider({ turns: turns() }),
		tools: registry(),
		runConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 1_000_000,
			maxIterations: 14,
			maxResponseTokens: 256,
		},
		agentId: 'agent_sal',
		agentName: 'Salience Agent',
		workingDirectory: await mkdtemp(join(tmpdir(), 'namzu-eval-sal-')),
		sessionId: 'ses_sal',
		threadId: 'thd_sal',
		projectId: 'prj_sal',
		tenantId: 'tnt_sal',
		messages: [{ role: 'user', content: `read the billing config and bill the right account`, timestamp: 1 }],
		resumeHandler: autoApproveHandler,
		compactionConfig: {
			strategy: input.strategy,
			contextWindowTokens: 8_000,
			keepRecentMessages: 2,
			llmVerification: false,
		},
	})
	const finalMessages = run.messages ?? []
	return Object.assign(evalRunFromRun(run), { finalMessages, contextChars: contextChars(finalMessages) })
}

/** The final history's size, the quantity the next call would have paid for. */
function contextChars(messages) {
	return messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0)
}

/**
 * The same script under the structured strategy, for the comparison the
 * scorers below make. Run inside the case rather than as a case of its
 * own, because a case that is expected to score low would fail the gate
 * for stating the baseline it exists to beat.
 */
async function withBaseline(input) {
	const salience = await runCase(input)
	const structured = await runCase({ strategy: 'structured' })
	return Object.assign(salience, {
		baseline: {
			contextChars: structured.contextChars,
			needleSurvived: (structured.finalMessages ?? []).some(
				(m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes(`account id is ${NEEDLE}`),
			),
		},
	})
}

const settled = customScorer('settled', (run) =>
	run.error ? { score: 0, reason: `run threw: ${run.error}` } : { score: 1, reason: `settled as ${run.stopReason ?? 'unknown'}` },
)

const noOrphanedResults = customScorer('no-orphaned-tool-results', (run) => {
	const callIds = new Set()
	for (const m of run.finalMessages ?? []) for (const tc of m.toolCalls ?? []) callIds.add(tc.id)
	const orphans = (run.finalMessages ?? []).filter((m) => m.role === 'tool' && !callIds.has(m.toolCallId))
	return orphans.length === 0
		? { score: 1, reason: 'every tool result still has its call' }
		: { score: 0, reason: `orphaned tool results: ${orphans.map((m) => m.toolCallId).join(', ')}` }
})

/** The fact a later turn cited is still readable verbatim at the end. */
const needleSurvives = customScorer('cited-fact-survives', (run) => {
	const verbatim = (run.finalMessages ?? []).some(
		(m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes(`account id is ${NEEDLE}`),
	)
	return verbatim
		? { score: 1, reason: 'the cited tool result kept its body' }
		: { score: 0, reason: 'the cited tool result was cleared or summarised away' }
})

/** The final history within the window it was held to. */
const heldWithinWindow = customScorer('held-within-window', (run) => {
	const tokens = Math.ceil(run.contextChars / 4)
	return {
		score: tokens <= 8_000 * 0.7 ? 1 : 0,
		reason: `final history ~${tokens.toLocaleString('en-US')} tokens against an 8,000 window`,
		details: { contextChars: run.contextChars },
	}
})

/** Keeps what structured lost, without a larger final history. */
const betterThanStructured = customScorer('keeps-more-for-no-more', (run) => {
	const baseline = run.baseline?.contextChars ?? Number.POSITIVE_INFINITY
	const structuredKept = run.baseline?.needleSurvived ?? true
	return {
		score: run.contextChars <= baseline * 1.1 && !structuredKept ? 1 : 0,
		reason: `final history ${run.contextChars.toLocaleString('en-US')} chars against ${baseline.toLocaleString('en-US')} structured; structured ${structuredKept ? 'kept' : 'lost'} the cited fact`,
		details: { salienceChars: run.contextChars, structuredChars: baseline, structuredKeptNeedle: structuredKept },
	}
})

export default async function salience() {
	return runExperiment({
		name: 'kernel/salience',
		scorers: [settled, noOrphanedResults, needleSurvives, heldWithinWindow, betterThanStructured],
		run: (input) => withBaseline(input),
		cases: [
			{ name: 'salience keeps the cited fact and holds the window', input: { strategy: 'salience' } },
		],
	})
}
