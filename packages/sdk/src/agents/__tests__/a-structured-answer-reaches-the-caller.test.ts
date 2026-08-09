/**
 * The front door can ask for a schema, and gets the parsed value back.
 *
 * `runAgent` never forwarded `structuredOutput`, so the most convenient way
 * into the kernel was the one way that could not produce a typed answer. The
 * runtime has parsed and validated these throughout — the eval harness reads
 * `run.structuredOutput` correctly, which is the proof the value is real and
 * only the ergonomic boundaries dropped it.
 *
 * Driven end-to-end through `runAgent` rather than against the parser: the
 * parser was never the broken part, and a test on it would pass against every
 * version of this defect.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider } from '../../provider/mock.js'
import { ToolRegistry } from '../../registry/tool/execute.js'
import { runAgent } from '../runAgent.js'

const SCHEMA = z.object({ city: z.string(), degrees: z.number() })
const ANSWER = { city: 'Ankara', degrees: 21 }

/**
 * A model that calls the structured-output tool with a valid payload.
 *
 * The tool name is the kernel's own constant rather than a literal, so a rename
 * breaks this test loudly instead of leaving it driving a tool that no longer
 * exists.
 */
async function runWithSchema(workingDirectory: string) {
	const { STRUCTURED_OUTPUT_TOOL_NAME } = await import('../../tools/builtins/structuredOutput.js')
	const provider = new MockLLMProvider({
		turns: [
			{
				toolCalls: [
					{
						id: 'so1',
						name: STRUCTURED_OUTPUT_TOOL_NAME,
						rawArguments: JSON.stringify(ANSWER),
					},
				],
			},
			{ text: 'done' },
		],
	})
	return runAgent({
		provider,
		model: 'm',
		prompt: 'what is the weather',
		tools: new ToolRegistry(),
		workingDirectory,
		maxIterations: 4,
		structuredOutput: { schema: SCHEMA },
	})
}

describe('runAgent with a schema', () => {
	it('returns the parsed object, on the result and on the run', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-so-'))
		const out = await runWithSchema(dir)

		// Both, because they are two different promises to a caller: `run` is the
		// durable record and `structuredOutput` is the ergonomic handle that did
		// not exist. A fix that populated only the run would leave the front door
		// exactly as unusable as it was.
		expect(out.run.structuredOutput).toEqual(ANSWER)
		expect(out.structuredOutput).toEqual(ANSWER)
	})

	it('puts the serialized answer on `output` instead of stale prose', async () => {
		// The changed default. `resolveResult` walks back from the message tail
		// and stops at the first non-assistant message, so a structured run — whose
		// last assistant turn is a tool call — used to keep whatever text an
		// earlier turn produced, or nothing at all. Either way the caller read
		// something that was not the answer.
		const dir = await mkdtemp(join(tmpdir(), 'namzu-so-'))
		const out = await runWithSchema(dir)

		expect(out.output).toBe(JSON.stringify(ANSWER))
		expect(out.run.result).toBe(JSON.stringify(ANSWER))
	})

	it('leaves `output` as prose when no schema was asked for', async () => {
		// The preservation half: the serialization must not reach an ordinary run.
		const dir = await mkdtemp(join(tmpdir(), 'namzu-so-'))
		const provider = new MockLLMProvider({ turns: [{ text: 'just prose' }] })

		const out = await runAgent({
			provider,
			model: 'm',
			prompt: 'hello',
			tools: new ToolRegistry(),
			workingDirectory: dir,
			maxIterations: 2,
		})

		expect(out.output).toBe('just prose')
		expect(out.structuredOutput).toBeUndefined()
	})
})
