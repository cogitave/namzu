import { z } from 'zod'

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
	strategy: z.enum(['structured', 'disabled']).default('structured'),
	triggerThreshold: z.number().min(0).max(1).default(0.7),
	resetThreshold: z.number().min(0).max(1).default(0.4),
	keepRecentMessages: z.number().positive().default(4),
	maxToolResults: z.number().positive().default(30),
	maxListSize: z.number().positive().default(25),
	llmVerification: z.boolean().default(true),
	llmVerificationMaxTokens: z.number().positive().default(2048),
	richStateThreshold: z.number().positive().default(15),
	convoTextBudget: z.number().positive().default(12_000),
	maxSentencesPerTurn: z.number().positive().default(5),
	maxCharsPerNote: z.number().positive().default(500),
	maxCharsPerRequirement: z.number().positive().default(300),
	maxCharsPerTask: z.number().positive().default(400),
})

export type CompactionConfig = z.infer<typeof CompactionConfigSchema>

export const RuntimeConfigSchema = z.object({
	model: z.string().default('qwen/qwen3.6-plus:free'),
	temperature: z.number().min(0).max(2).default(0.3),
	tokenBudget: z.number().positive().default(100_000),
	maxResponseTokens: z.number().positive().default(8192),
	timeoutMs: z.number().positive().default(600_000),
	maxIterations: z.number().positive().default(200),
	taskRouter: TaskRouterConfigSchema,
	compaction: CompactionConfigSchema.default({}),
})

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>

export const RUNTIME_DEFAULTS: Readonly<RuntimeConfig> = RuntimeConfigSchema.parse({})
