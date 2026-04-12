/**
 * Real-world examples of using createStructuredOutputTool
 *
 * These examples demonstrate how to use the structured output tool
 * to force agents to produce validated, typed output.
 */

import { z } from 'zod'
import { createStructuredOutputTool } from '../structuredOutput.js'

// ============================================================================
// Example 1: Code Review Analysis
// ============================================================================

const CodeReviewSchema = z.object({
	status: z.enum(['approved', 'changes_requested', 'rejected']),
	summary: z.string().describe('Overall summary of the review'),
	issues: z.array(
		z.object({
			file: z.string(),
			line: z.number().int().positive(),
			severity: z.enum(['critical', 'major', 'minor']),
			message: z.string(),
			suggestion: z.string().optional(),
		}),
	),
	strengths: z.array(z.string()).describe('What was done well'),
	suggestions: z.array(z.string()).describe('Actionable improvements'),
})

export const createCodeReviewTool = () => createStructuredOutputTool(CodeReviewSchema)

// Usage example:
// const tool = createCodeReviewTool()
// await toolRegistry.register(tool)
// // Model analyzes code...
// const review = extractToolResult(messages, 'structured_output')
// const typedReview: z.infer<typeof CodeReviewSchema> = JSON.parse(review.output)

// ============================================================================
// Example 2: Document Summarization
// ============================================================================

const DocumentSummarySchema = z.object({
	title: z.string(),
	category: z.enum(['technical', 'business', 'legal', 'other']),
	summary: z.string().min(100).max(500),
	key_points: z.array(z.string()).min(3).max(10),
	metadata: z.object({
		source: z.string().optional(),
		date: z.string().datetime().optional(),
		language: z.string().default('en'),
	}),
})

export const createDocumentSummaryTool = () => createStructuredOutputTool(DocumentSummarySchema)

// ============================================================================
// Example 3: Data Extraction
// ============================================================================

const ExtractedDataSchema = z.object({
	entities: z.array(
		z.object({
			type: z.enum(['person', 'organization', 'location', 'date', 'amount']),
			text: z.string(),
			confidence: z.number().min(0).max(1),
		}),
	),
	relationships: z.array(
		z.object({
			subject: z.string(),
			predicate: z.string(),
			object: z.string(),
		}),
	),
})

export const createDataExtractionTool = () => createStructuredOutputTool(ExtractedDataSchema)

// ============================================================================
// Example 4: Task Execution Status
// ============================================================================

const TaskResultSchema = z.object({
	task_id: z.string(),
	status: z.enum(['success', 'partial', 'failed']),
	result: z.record(z.unknown()).describe('Task-specific result data'),
	errors: z
		.array(
			z.object({
				code: z.string(),
				message: z.string(),
				details: z.string().optional(),
			}),
		)
		.default([]),
	metadata: z.object({
		duration_ms: z.number().int().positive().optional(),
		attempts: z.number().int().min(1),
		timestamp: z.string().datetime(),
	}),
})

export const createTaskResultTool = () => createStructuredOutputTool(TaskResultSchema)

// ============================================================================
// Example 5: Diagnosis/Decision Making
// ============================================================================

const DiagnosisSchema = z.object({
	diagnosis: z.string(),
	confidence: z.number().min(0).max(1),
	differential: z.array(
		z.object({
			diagnosis: z.string(),
			probability: z.number().min(0).max(1),
		}),
	),
	recommended_actions: z.array(z.string()),
	urgency: z.enum(['low', 'medium', 'high', 'critical']),
})

export const createDiagnosisTool = () => createStructuredOutputTool(DiagnosisSchema)

// ============================================================================
// Example 6: Multi-language Translation
// ============================================================================

const TranslationSchema = z.object({
	source_text: z.string(),
	source_language: z.string(),
	target_language: z.string(),
	translation: z.string(),
	confidence: z.number().min(0).max(1),
	notes: z.string().optional(),
	alternatives: z
		.array(
			z.object({
				text: z.string(),
				note: z.string(),
			}),
		)
		.optional(),
})

export const createTranslationTool = () => createStructuredOutputTool(TranslationSchema)

// ============================================================================
// Example 7: Test Report Generation
// ============================================================================

const TestReportSchema = z.object({
	total_tests: z.number().int().nonnegative(),
	passed: z.number().int().nonnegative(),
	failed: z.number().int().nonnegative(),
	skipped: z.number().int().nonnegative(),
	coverage_percent: z.number().min(0).max(100),
	failures: z.array(
		z.object({
			test_name: z.string(),
			error_message: z.string(),
			stack_trace: z.string().optional(),
		}),
	),
	summary: z.string(),
})

export const createTestReportTool = () => createStructuredOutputTool(TestReportSchema)

// ============================================================================
// Integration Pattern
// ============================================================================

/**
 * Example of how to integrate structured output into an agent iteration:
 *
 * ```typescript
 * async function queryWithStructuredOutput(
 *   toolRegistry: ToolRegistry,
 *   schema: z.ZodType,
 *   messages: Message[]
 * ): Promise<any> {
 *   const tool = createStructuredOutputTool(schema)
 *
 *   try {
 *     // Register the tool
 *     toolRegistry.register(tool)
 *
 *     // Run the iteration with this tool available
 *     // (in real usage, this would be integrated with the iteration loop)
 *     const response = await provider.chat({
 *       messages,
 *       tools: toolRegistry.toLLMTools(),
 *       toolChoice: {
 *         type: 'function',
 *         function: { name: 'structured_output' }
 *       }
 *     })
 *
 *     // Extract the result
 *     const toolCall = response.message.toolCalls?.find(
 *       tc => tc.function.name === 'structured_output'
 *     )
 *
 *     if (toolCall) {
 *       const args = JSON.parse(toolCall.function.arguments)
 *       return {
 *         success: true,
 *         data: args
 *       }
 *     }
 *
 *     return { success: false, error: 'Tool was not called' }
 *   } finally {
 *     // Clean up
 *     toolRegistry.unregister('structured_output')
 *   }
 * }
 * ```
 */
