import { z } from 'zod'
import type { TokenUsage } from '../common/index.js'
import type { EmergencySaveId, RunId } from '../ids/index.js'
import type { Message } from '../message/index.js'

export interface EmergencySaveData {
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
