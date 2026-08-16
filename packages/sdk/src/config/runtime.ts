import { z } from 'zod'
import { HOOK_TIMEOUT_MS } from '../constants/plugin/index.js'
import { SandboxConfigSchema } from '../types/sandbox/index.js'

export { SandboxConfigSchema }

export const TaskRouterConfigSchema = z
	.object({
		compaction: z.string().nullish(),
		summarization: z.string().nullish(),
		exploration: z.string().nullish(),
		coding: z.string().nullish(),
		verification: z.string().nullish(),
		planning: z.string().nullish(),
		default: z.string().nullish(),
	})
	.optional()

export const CompactionConfigSchema = z.object({
	strategy: z.enum(['structured', 'sliding-window', 'disabled']).default('structured'),
	/**
	 * Optional model context-window size (tokens) the compaction trigger
	 * measures the CURRENT window against. NO default: when omitted the
	 * trigger falls back to the run-level cumulative `tokenBudget` exactly as
	 * before, so existing consumers are byte-identical. Hosts that keep
	 * `tokenBudget` unlimited (0) set this so compaction fires on
	 * window-pressure instead of being a silent no-op.
	 */
	contextWindowTokens: z.number().int().positive().optional(),
	/** Fraction of the context window at which a compaction pass fires. */
	triggerThreshold: z.number().min(0).max(1).default(0.7),
	/**
	 * Fraction the pass must get the context BELOW to be worth keeping.
	 *
	 * This is hysteresis, and without it compaction can thrash: a pass that
	 * only shaves the context from 0.72 to 0.71 of the window leaves the
	 * trigger armed, so the next iteration compacts again — paying a
	 * summarization call and busting the prompt-cache prefix each time, for
	 * nothing. A pass that cannot reach this level logs the shortfall and
	 * the run continues rather than repeating a move that does not work.
	 *
	 * The field was declared and set by the shipped CLI but read by nothing;
	 * the choice was to implement it or delete it, and thrash is a real
	 * failure mode once the trigger actually fires.
	 */
	resetThreshold: z.number().min(0).max(1).default(0.4),
	keepRecentMessages: z.number().int().positive().default(4),
	/**
	 * Size the retained tail by TOKENS instead of by message count.
	 *
	 * A count cannot express what the tail costs. Four messages is four
	 * short turns or three short turns and a 200 KB tool result, and in the
	 * second case the tail alone can approach `resetThreshold` — the pass
	 * completes, reports it did not reach the threshold, leaves the trigger
	 * armed, and the next iteration pays another summarization call and
	 * busts the prompt-cache prefix again.
	 *
	 * Absent means the count is used, exactly as before. Set, it replaces
	 * only the NAIVE boundary; the safe-cut search that keeps a `tool_use`
	 * with its `tool_result` runs from there unchanged.
	 */
	keepRecentTokens: z.number().int().positive().optional(),

	/**
	 * Before summarizing destructively, clear the OUTPUT of old, large tool
	 * results in place.
	 *
	 * Compaction paraphrases the agent's own reasoning away — the decisions,
	 * the false starts it learned from, the exact wording of a plan. That is
	 * a heavy price for a context problem usually caused by something much
	 * dumber: a few enormous tool outputs the agent already read and moved
	 * past. Clearing those reclaims most of the same tokens while keeping
	 * every message verbatim, and it is safe where trimming is not, because
	 * nothing moves — the `tool_use` ↔ `tool_result` pairing is untouched by
	 * construction.
	 *
	 * If the clear gets the context back under `triggerThreshold`, the
	 * summarization pass is skipped entirely. Set `false` to go straight to
	 * summarization.
	 */
	clearToolResults: z.boolean().default(true),
	/**
	 * Record what each pass removes, as a `compaction_shed` event.
	 *
	 * On by default: without it the shed content exists nowhere afterwards
	 * — not in memory, not in `messages.json`, not in the transcript — and
	 * "what did the agent decide three compactions ago" is unanswerable.
	 *
	 * Off is for an operator with a transcript-size constraint, and it is a
	 * real trade: the transcript grows by roughly what the compaction saved
	 * in context, since the whole point is that the bodies are kept.
	 */
	recordShedHistory: z.boolean().default(true),
	/** Most recent tool results left alone — the agent is likely still using them. */
	keepRecentToolResults: z.number().min(0).default(3),
	/**
	 * Don't clear results smaller than this. Below it the placeholder is
	 * comparable in size to the output, so the churn buys nothing and costs
	 * the model a confusing hole in its history.
	 */
	minToolResultCharsToClear: z.number().min(0).default(1_000),
	/** Tools whose output is never cleared, by name. */
	preserveToolResultsFrom: z.array(z.string()).optional(),

	maxToolResults: z.number().int().positive().default(30),
	maxListSize: z.number().int().positive().default(25),
	/**
	 * Entries pinned at the head of each capped list, never evicted.
	 *
	 * Eviction used to drop the OLDEST entry, so a long run silently
	 * deleted the decision that set its approach while keeping the last
	 * twenty-five incidental notes. The early entries are the load-bearing
	 * ones and the recent ones are still in the un-compacted tail.
	 */
	keepFirstEntries: z.number().min(0).default(3),
	llmVerification: z.boolean().default(true),
	llmVerificationMaxTokens: z.number().int().positive().default(2048),
	richStateThreshold: z.number().int().positive().default(15),
	convoTextBudget: z.number().int().positive().default(12_000),
	maxSentencesPerTurn: z.number().int().positive().default(5),
	maxCharsPerNote: z.number().int().positive().default(500),
	maxCharsPerRequirement: z.number().int().positive().default(300),
	maxCharsPerTask: z.number().int().positive().default(400),
})

export type CompactionConfig = z.infer<typeof CompactionConfigSchema>

export const AgentBusConfigSchema = z.object({
	enabled: z.boolean().default(false),
	lockTimeoutMs: z.number().int().positive().default(60_000),
	lockAcquireTimeoutMs: z.number().int().positive().default(5_000),
	maxLocksPerAgent: z.number().int().positive().default(10),
	breakerFailureThreshold: z.number().int().positive().default(5),
	breakerResetTimeoutMs: z.number().int().positive().default(30_000),
})

export type AgentBusConfig = z.infer<typeof AgentBusConfigSchema>

export const PromptCacheConfigSchema = z.object({
	enabled: z.boolean().default(true),
	strategy: z.enum(['auto', 'disabled']).default('auto'),
})

export const PluginRuntimeConfigSchema = z.object({
	enabled: z.boolean().default(false),
	autoDiscovery: z.boolean().default(true),
	allowedScopes: z.array(z.enum(['project', 'user'])).default(['project', 'user']),
	hookTimeoutMs: z.number().int().positive().default(HOOK_TIMEOUT_MS),
})

export type PluginRuntimeConfig = z.infer<typeof PluginRuntimeConfigSchema>

export const RuntimeConfigSchema = z.object({
	model: z.string().default('qwen/qwen3.6-plus:free'),
	temperature: z.number().min(0).max(2).default(0.3),
	tokenBudget: z.number().nonnegative().default(100_000),
	maxResponseTokens: z.number().int().positive().default(8192),
	timeoutMs: z.number().int().positive().default(600_000),
	maxIterations: z.number().int().positive().default(200),
	taskRouter: TaskRouterConfigSchema,
	compaction: CompactionConfigSchema.default({}),
	agentBus: AgentBusConfigSchema.optional(),
	plugins: PluginRuntimeConfigSchema.optional(),
	sandbox: SandboxConfigSchema.optional(),
})

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>

export const RUNTIME_DEFAULTS: Readonly<RuntimeConfig> = RuntimeConfigSchema.parse({})
