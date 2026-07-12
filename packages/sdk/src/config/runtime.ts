import { z } from 'zod'
import { HOOK_TIMEOUT_MS } from '../constants/plugin/index.js'
import type { RetryConfig } from '../types/run/config.js'
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

/**
 * A compaction budget: a COUNT of messages, slots, tokens, or characters.
 *
 * Every one of these is a finite positive integer, and the schema has to say so —
 * `z.number().positive()` does not. It admits `0.5`, which a character cap then
 * spends as one whole character (`slice(0, 0.5)` keeps nothing; the floor keeps one),
 * so the budget is exceeded by the very code enforcing it. And it admits `Infinity`,
 * which every `used + cost <= budget` comparison passes: the carry that these budgets
 * exist to BOUND grows without limit, and the "bounded carry" the compaction pass
 * promises is simply false. A fractional message count is no better — it is compared
 * against array lengths and halved with `Math.floor`.
 *
 * Rejecting the degenerate values at the boundary is what lets the code downstream
 * state its guarantees plainly (ses_015 pre-freeze R6 M1).
 */
const budget = () => z.number().int().positive().finite()

export const CompactionConfigSchema = z.object({
	strategy: z.enum(['structured', 'sliding-window', 'disabled']).default('structured'),
	triggerThreshold: z.number().min(0).max(1).default(0.7),
	resetThreshold: z.number().min(0).max(1).default(0.4),
	keepRecentMessages: budget().default(4),
	maxToolResults: budget().default(30),
	maxListSize: budget().default(25),
	llmVerification: z.boolean().default(true),
	llmVerificationMaxTokens: budget().default(2048),
	richStateThreshold: budget().default(15),
	convoTextBudget: budget().default(12_000),
	maxSentencesPerTurn: budget().default(5),
	maxCharsPerNote: budget().default(500),
	maxCharsPerRequirement: budget().default(300),
	maxCharsPerTask: budget().default(400),
})

export type CompactionConfig = z.infer<typeof CompactionConfigSchema>

export const AgentBusConfigSchema = z.object({
	enabled: z.boolean().default(false),
	lockTimeoutMs: z.number().positive().default(60_000),
	lockAcquireTimeoutMs: z.number().positive().default(5_000),
	maxLocksPerAgent: z.number().positive().default(10),
	breakerFailureThreshold: z.number().positive().default(5),
	breakerResetTimeoutMs: z.number().positive().default(30_000),
})

export type AgentBusConfig = z.infer<typeof AgentBusConfigSchema>

export const RetryConfigSchema = z.object({
	enabled: z.boolean().default(true),
	maxAttempts: z.number().int().positive().default(3),
	baseDelayMs: z.number().nonnegative().default(1000),
	maxDelayMs: z.number().nonnegative().default(30_000),
	overflowAttempts: z.number().int().nonnegative().default(2),
})

/**
 * Fully-resolved retry defaults, derived from {@link RetryConfigSchema} so the
 * schema stays the single source of truth. `satisfies RetryConfig` pins the
 * shape to the hand-written interface in `types/run/config.ts`.
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = RetryConfigSchema.parse({})

export const PromptCacheConfigSchema = z.object({
	enabled: z.boolean().default(true),
	strategy: z.enum(['auto', 'disabled']).default('auto'),
})

export const PluginRuntimeConfigSchema = z.object({
	enabled: z.boolean().default(false),
	autoDiscovery: z.boolean().default(true),
	allowedScopes: z.array(z.enum(['project', 'user'])).default(['project', 'user']),
	hookTimeoutMs: z.number().positive().default(HOOK_TIMEOUT_MS),
})

export type PluginRuntimeConfig = z.infer<typeof PluginRuntimeConfigSchema>

export const RuntimeConfigSchema = z.object({
	model: z.string().default('qwen/qwen3.6-plus:free'),
	temperature: z.number().min(0).max(2).default(0.3),
	tokenBudget: z.number().positive().default(100_000),
	maxResponseTokens: z.number().positive().default(8192),
	timeoutMs: z.number().positive().default(600_000),
	maxIterations: z.number().positive().default(200),
	taskRouter: TaskRouterConfigSchema,
	compaction: CompactionConfigSchema.default({}),
	retry: RetryConfigSchema.default({}),
	agentBus: AgentBusConfigSchema.optional(),
	promptCache: PromptCacheConfigSchema.optional(),
	plugins: PluginRuntimeConfigSchema.optional(),
	sandbox: SandboxConfigSchema.optional(),
})

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>

export const RUNTIME_DEFAULTS: Readonly<RuntimeConfig> = RuntimeConfigSchema.parse({})
