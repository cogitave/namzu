import { z } from 'zod'

export const RuntimeConfigSchema = z.object({
	model: z.string().default('qwen/qwen3.6-plus:free'),
	temperature: z.number().min(0).max(2).default(0.3),
	tokenBudget: z.number().positive().default(100_000),
	maxResponseTokens: z.number().positive().default(8192),
	timeoutMs: z.number().positive().default(600_000),
	maxIterations: z.number().positive().default(200),
})

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>

export const RUNTIME_DEFAULTS: Readonly<RuntimeConfig> = RuntimeConfigSchema.parse({})
