import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ToolContext } from '../../../types/tool/index.js'
import { STRUCTURED_OUTPUT_TOOL_NAME, createStructuredOutputTool } from '../structuredOutput.js'

describe('structuredOutput', () => {
	describe('STRUCTURED_OUTPUT_TOOL_NAME', () => {
		it('should export the constant with correct value', () => {
			expect(STRUCTURED_OUTPUT_TOOL_NAME).toBe('structured_output')
		})
	})

	describe('createStructuredOutputTool', () => {
		it('should create a tool with correct name and description', () => {
			const schema = z.object({ result: z.string() })
			const tool = createStructuredOutputTool(schema)

			expect(tool.name).toBe('structured_output')
			expect(tool.description).toContain('MUST call this tool')
		})

		it('should have correct tool properties', () => {
			const schema = z.object({ result: z.string() })
			const tool = createStructuredOutputTool(schema)

			expect(tool.category).toBe('analysis')
			expect(tool.isReadOnly?.({} as any)).toBe(true)
			expect(tool.isDestructive?.({} as any)).toBe(false)
			expect(tool.isConcurrencySafe?.({} as any)).toBe(true)
			expect(tool.permissions).toEqual([])
		})

		it('should use the provided schema as input schema', () => {
			const schema = z.object({
				title: z.string(),
				count: z.number(),
			})
			const tool = createStructuredOutputTool(schema)

			expect(tool.inputSchema).toBe(schema)
		})

		it('should execute successfully with valid input', async () => {
			const schema = z.object({
				title: z.string(),
				summary: z.string(),
			})
			const tool = createStructuredOutputTool(schema)

			const input = {
				title: 'Test Title',
				summary: 'Test Summary',
			}

			const mockContext: ToolContext = {
				runId: 'run_test' as any,
				workingDirectory: '/tmp',
				abortSignal: new AbortController().signal,
				env: {},
				log: () => {},
			}

			const result = await tool.execute(input, mockContext)

			expect(result.success).toBe(true)
			expect(result.data).toEqual(input)
			expect(result.output).toBe(JSON.stringify(input))
			expect(result.error).toBeUndefined()
		})

		it('should handle complex nested schemas', async () => {
			const schema = z.object({
				name: z.string(),
				metadata: z.object({
					tags: z.array(z.string()),
					settings: z.record(z.unknown()),
				}),
			})
			const tool = createStructuredOutputTool(schema)

			const input = {
				name: 'Complex Object',
				metadata: {
					tags: ['tag1', 'tag2'],
					settings: { timeout: 5000, retries: 3 },
				},
			}

			const mockContext: ToolContext = {
				runId: 'run_test' as any,
				workingDirectory: '/tmp',
				abortSignal: new AbortController().signal,
				env: {},
				log: () => {},
			}

			const result = await tool.execute(input, mockContext)

			expect(result.success).toBe(true)
			expect(result.data).toEqual(input)
			const parsed = JSON.parse(result.output)
			expect(parsed).toEqual(input)
		})

		it('should handle arrays in schema', async () => {
			const schema = z.object({
				items: z.array(
					z.object({
						id: z.number(),
						value: z.string(),
					}),
				),
			})
			const tool = createStructuredOutputTool(schema)

			const input = {
				items: [
					{ id: 1, value: 'first' },
					{ id: 2, value: 'second' },
				],
			}

			const mockContext: ToolContext = {
				runId: 'run_test' as any,
				workingDirectory: '/tmp',
				abortSignal: new AbortController().signal,
				env: {},
				log: () => {},
			}

			const result = await tool.execute(input, mockContext)

			expect(result.success).toBe(true)
			expect(result.data).toEqual(input)
			expect(JSON.parse(result.output)).toEqual(input)
		})

		it('should handle optional fields', async () => {
			const schema = z.object({
				required: z.string(),
				optional: z.string().optional(),
			})
			const tool = createStructuredOutputTool(schema)

			const input = {
				required: 'value',
				optional: undefined,
			}

			const mockContext: ToolContext = {
				runId: 'run_test' as any,
				workingDirectory: '/tmp',
				abortSignal: new AbortController().signal,
				env: {},
				log: () => {},
			}

			const result = await tool.execute(input, mockContext)

			expect(result.success).toBe(true)
			expect((result.data as typeof input)?.required).toBe('value')
		})

		it('should handle boolean and number values', async () => {
			const schema = z.object({
				active: z.boolean(),
				count: z.number(),
				rate: z.number(),
			})
			const tool = createStructuredOutputTool(schema)

			const input = {
				active: true,
				count: 42,
				rate: 3.14,
			}

			const mockContext: ToolContext = {
				runId: 'run_test' as any,
				workingDirectory: '/tmp',
				abortSignal: new AbortController().signal,
				env: {},
				log: () => {},
			}

			const result = await tool.execute(input, mockContext)

			expect(result.success).toBe(true)
			expect(result.data).toEqual(input)
		})

		it('should support union types', async () => {
			const schema = z.object({
				status: z.enum(['pending', 'completed', 'failed']),
				result: z.union([z.string(), z.number()]),
			})
			const tool = createStructuredOutputTool(schema)

			const input = {
				status: 'completed' as const,
				result: 'success',
			}

			const mockContext: ToolContext = {
				runId: 'run_test' as any,
				workingDirectory: '/tmp',
				abortSignal: new AbortController().signal,
				env: {},
				log: () => {},
			}

			const result = await tool.execute(input, mockContext)

			expect(result.success).toBe(true)
			expect((result.data as typeof input)?.status).toBe('completed')
			expect((result.data as typeof input)?.result).toBe('success')
		})

		it('should create multiple independent tools', () => {
			const schema1 = z.object({ type: z.literal('type1'), data: z.string() })
			const schema2 = z.object({ type: z.literal('type2'), count: z.number() })

			const tool1 = createStructuredOutputTool(schema1)
			const tool2 = createStructuredOutputTool(schema2)

			// Both should have the same name (that's the point - it's a special tool)
			expect(tool1.name).toBe(tool2.name)
			expect(tool1.name).toBe('structured_output')

			// But their input schemas should be different
			expect(tool1.inputSchema).not.toBe(tool2.inputSchema)
		})

		it('should not throw on execute', async () => {
			const schema = z.object({ value: z.string() })
			const tool = createStructuredOutputTool(schema)

			const mockContext: ToolContext = {
				runId: 'run_test' as any,
				workingDirectory: '/tmp',
				abortSignal: new AbortController().signal,
				env: {},
				log: () => {},
			}

			await expect(tool.execute({ value: 'test' }, mockContext)).resolves.toBeDefined()
		})

		it('should handle null values in nullable fields', async () => {
			const schema = z.object({
				required: z.string(),
				nullable: z.string().nullable(),
			})
			const tool = createStructuredOutputTool(schema)

			const input = {
				required: 'value',
				nullable: null,
			}

			const mockContext: ToolContext = {
				runId: 'run_test' as any,
				workingDirectory: '/tmp',
				abortSignal: new AbortController().signal,
				env: {},
				log: () => {},
			}

			const result = await tool.execute(input, mockContext)

			expect(result.success).toBe(true)
			expect((result.data as typeof input)?.nullable).toBeNull()
		})
	})
})
