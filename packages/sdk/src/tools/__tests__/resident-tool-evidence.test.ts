import { expect, it, vi } from 'vitest'
import type { ResidentToolEvidenceSource } from '../../manager/resident/tool-evidence.js'
import { ToolRegistry } from '../../registry/tool/execute.js'
import type { ToolContext } from '../../types/tool/index.js'
import { generateRunId } from '../../utils/id.js'
import { buildResidentToolEvidenceTools } from '../resident-tool-evidence.js'

it('rejects model-selected authority and malformed pointers before resolving the host', async () => {
	const resolve = vi.fn<() => ResidentToolEvidenceSource>()
	const registry = new ToolRegistry()
	registry.register(buildResidentToolEvidenceTools(resolve))
	const context: ToolContext = {
		runId: generateRunId(),
		workingDirectory: '/tmp',
		env: {},
		log() {},
		abortSignal: new AbortController().signal,
	}
	for (const input of [
		{ path: '/private' },
		{ query: 'q', tenantId: 'other' },
		{ cursor: 'x'.repeat(8193) },
	])
		expect((await registry.execute('search_resident_tools', input, context)).success).toBe(false)
	for (const input of [
		{ revision: 0, address: 'x' },
		{ revision: 2, address: 'x', byteOffset: -1 },
		{ revision: 2, address: 'x', runId: 'other' },
	])
		expect((await registry.execute('read_resident_tool', input, context)).success).toBe(false)
	expect(resolve).not.toHaveBeenCalled()
})

it('forwards exact pagination and cancellation, and never leaks host rejection details', async () => {
	const context: ToolContext = {
		runId: generateRunId(),
		workingDirectory: '/tmp',
		env: {},
		log() {},
		abortSignal: new AbortController().signal,
	}
	const read = vi.fn().mockResolvedValue({ text: 'retained text', nextByteOffset: 17 })
	const tools = buildResidentToolEvidenceTools((request) => {
		if (request.runId !== context.runId) throw new Error('/private/source contains SECRET')
		return { read } as unknown as ResidentToolEvidenceSource
	})
	const input = { revision: 3, address: 'opaque', byteOffset: 8 }
	expect(await tools[1]!.execute(input, context)).toMatchObject({
		success: true,
		output: JSON.stringify({ text: 'retained text', nextByteOffset: 17 }),
	})
	expect(read).toHaveBeenCalledExactlyOnceWith(input, context.abortSignal)
	const refused = await tools[1]!.execute(input, { ...context, runId: generateRunId() })
	expect(refused.success).toBe(false)
	expect(JSON.stringify(refused)).not.toContain('SECRET')
	expect(
		await tools[1]!.execute(input, {
			...context,
			abortSignal: AbortSignal.abort(new Error('cancelled')),
		}),
	).toMatchObject({ success: false, error: expect.stringContaining('cancelled') })
	expect(read).toHaveBeenCalledTimes(1)
})
