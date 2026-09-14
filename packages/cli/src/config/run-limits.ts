import { constants } from 'node:fs'
import { type FileHandle, open } from 'node:fs/promises'
import type { CheckpointRunScope } from '@namzu/sdk'
import type { RunLimitsConfig } from './schema.js'

export type RunGuardKey = 'tokenBudget' | 'maxIterations' | 'timeoutMs'
export type RunGuards = { -readonly [K in RunGuardKey]: number }

/** CLI policy; independent of the SDK's defaults for embedding hosts. */
export function resolveRunGuards(...layers: readonly (RunLimitsConfig | undefined)[]): RunGuards {
	const resolved: RunGuards = { tokenBudget: 0, maxIterations: 0, timeoutMs: 0 }
	for (const layer of layers) {
		for (const key of ['tokenBudget', 'maxIterations', 'timeoutMs'] as const) {
			const value = layer?.[key]
			if (value === undefined) continue
			if (
				!Number.isSafeInteger(value) ||
				value < 0 ||
				(key === 'timeoutMs' && value > 2_147_483_647)
			)
				throw new Error(
					`Invalid ${key}: use a nonnegative safe integer${key === 'timeoutMs' ? ' at most 2147483647' : ''}. 0 means unlimited.`,
				)
			resolved[key] = value
		}
	}
	return resolved
}

/** Restore the run's own settings, including overrides made before a provider pause. */
export async function readStoredRunGuards(
	path: string,
	scope: CheckpointRunScope,
): Promise<RunGuards | undefined> {
	let file: FileHandle
	try {
		file = await open(
			path,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
		)
	} catch (error) {
		// An embedded checkpoint-only host may have no CLI run metadata.
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
		throw error
	}
	try {
		const before = await file.stat()
		if (!before.isFile() || before.size > 512 * 1024)
			throw new Error('Invalid run metadata size or file type')
		const bytes = Buffer.alloc(before.size)
		let offset = 0
		while (offset < bytes.length) {
			const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
			if (!bytesRead) throw new Error('Run metadata shortened during read')
			offset += bytesRead
		}
		const after = await file.stat()
		if (
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs
		)
			throw new Error('Run metadata changed during read')
		const record = JSON.parse(bytes.toString('utf8'))
		if (
			record?.schemaVersion !== 1 ||
			record.id !== scope.runId ||
			!['tenantId', 'projectId', 'sessionId', 'runId'].every(
				(key) => record.metadata?.scope?.[key] === scope[key as keyof CheckpointRunScope],
			)
		)
			throw new Error('Run metadata schema or scope does not match the resumed run')
		const config = record.metadata?.config
		if (
			!config ||
			['tokenBudget', 'maxIterations', 'timeoutMs'].some((key) => typeof config[key] !== 'number')
		)
			throw new Error('Run metadata does not contain its original limits')
		return resolveRunGuards(config)
	} finally {
		await file.close()
	}
}
