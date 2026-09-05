import { z } from 'zod'
import type { TokenUsage } from '../common/index.js'
import type { EmergencySaveId, RunId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { TokenBudgetBinding } from './token-budget-store.js'

export interface EmergencySaveData {
	/** Reference to the canonical tree ledger; a checkpoint never resets it. */
	readonly budgetBinding?: TokenBudgetBinding
	/** Also present for non-durable accounts; those require the live authority on resume. */
	readonly budgetAccountId?: string
	id: EmergencySaveId
	runId: RunId
	messages: Message[]
	tokenUsage: TokenUsage
	currentIteration: number
	startedAt: number
	savedAt: number
	processSignal: string
	lastError?: string
}

export const EmergencySaveConfigSchema = z.object({
	enabled: z.boolean().default(true),
	emergencyDir: z.string().optional(),
})

export type EmergencySaveConfig = z.infer<typeof EmergencySaveConfigSchema>
