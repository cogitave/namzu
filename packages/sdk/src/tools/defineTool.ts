import type { z } from 'zod'
import type {
	ToolContext,
	ToolDefinition,
	ToolPermission,
	ToolResult,
} from '../types/tool/index.js'
import type { ToolPresentation } from '../types/tool/presentation.js'
import { toErrorMessage } from '../utils/error.js'

export interface DefineToolOptions<S extends z.ZodType> {
	name: string
	description: string
	inputSchema: S
	modelInputSchema?: Record<string, unknown>
	enforceModelInput?: boolean
	validationErrorHint?: string
	/** Advice for a call cut off before its arguments closed; see {@link ToolDefinition.truncatedInputHint}. */
	truncatedInputHint?: string
	/** Advice for a call whose arguments were not valid JSON, in place of `validationErrorHint`; see {@link ToolDefinition.malformedInputHint}. */
	malformedInputHint?: string
	/** Arguments carrying long text, with budgets; see {@link ToolDefinition.largeStringArguments}. */
	largeStringArguments?: Readonly<Record<string, number>>
	category: ToolDefinition['category']
	permissions: ToolPermission[]
	/** Whether this exact call only observes state; conservative for unknown inputs. */
	readOnly: boolean | ((input: z.infer<S>) => boolean)
	destructive: boolean | ((input: z.infer<S>) => boolean)
	concurrencySafe: boolean
	/** Batch ordering boundary; see {@link ToolDefinition.executionBarrier}. */
	executionBarrier?: boolean
	tier?: string
	/**
	 * How this tool's call and result should be shown; see
	 * {@link ToolPresentation}.
	 *
	 * Here rather than only on `ToolDefinition` for the reason `maxRetries`
	 * is: this builder is the sanctioned way to author a tool, and a field
	 * the executor reads that the builder cannot set is a field only
	 * hand-written definitions can use.
	 */
	presentCall?: ToolPresentation<z.infer<S>>['presentCall']
	presentResult?: ToolPresentation<z.infer<S>>['presentResult']
	/** Per-execution deadline; see {@link ToolDefinition.timeoutMs}. */
	timeoutMs?: number
	/**
	 * In-loop retry budget for a FAILED execution; see
	 * {@link ToolDefinition.maxRetries}.
	 *
	 * The executor has always read this field, and this builder — the
	 * sanctioned way to author a tool — had no way to set it, so the
	 * documented "the tool author opts in, per tool" was reachable only by
	 * hand-writing the interface.
	 */
	maxRetries?: number
	/** Return shape shown to the model; see {@link ToolDefinition.outputSchema}. */
	outputSchema?: Record<string, unknown>
	/** Settle the turn with this tool's output; see {@link ToolDefinition.terminal}. */
	terminal?: boolean
	/**
	 * The argument holding a shell command line; see
	 * {@link ToolDefinition.commandArgument}.
	 *
	 * Here as well as on the definition for the reason `maxRetries` and
	 * `presentCall` are: this builder is the sanctioned way to author a tool,
	 * and a field a host reads that the builder cannot set is a field only
	 * hand-written definitions can use.
	 */
	commandArgument?: string
	/** The shell the command argument runs in; see {@link ToolDefinition.commandDialect}. */
	commandDialect?: ToolDefinition['commandDialect']
	/** The argument holding a filesystem path; see {@link ToolDefinition.pathArgument}. */
	pathArgument?: string
	/** The argument holding a canonical URL; see {@link ToolDefinition.urlArgument}. */
	urlArgument?: string
	/** The argument asking to leave the sandbox; see {@link ToolDefinition.sandboxEscapeArgument}. */
	sandboxEscapeArgument?: string
	execute(input: z.infer<S>, context: ToolContext): Promise<ToolResult>
}

/**
 * The `isDestructive` functions built from a literal `destructive: true`.
 *
 * Such a tool is destructive for EVERY input, so no call of it can ever be
 * approved without review — and a grant that names it (a skill's
 * `allowed-tools: Write`) would be a promise the review phase never keeps.
 * Kept here rather than as a field on the definition so the public
 * `ToolDefinition` shape does not change; see {@link isAlwaysDestructive}.
 */
const ALWAYS_DESTRUCTIVE = new WeakSet<object>()

/**
 * Whether a tool declares every call destructive, whatever the input.
 *
 * Known only for a tool built by {@link defineTool} with `destructive: true`.
 * A hand-written definition, or one whose flag depends on the input, answers
 * `false`: its calls are still judged one by one, so nothing is lost but an
 * early warning.
 */
export function isAlwaysDestructive(tool: Pick<ToolDefinition, 'isDestructive'>): boolean {
	return tool.isDestructive !== undefined && ALWAYS_DESTRUCTIVE.has(tool.isDestructive)
}

function constantDestructive(value: boolean): () => boolean {
	const fn = () => value
	if (value) ALWAYS_DESTRUCTIVE.add(fn)
	return fn
}

export function defineTool<S extends z.ZodType>(
	options: DefineToolOptions<S>,
): ToolDefinition<z.infer<S>> {
	type TInput = z.infer<S>

	return {
		name: options.name,
		description: options.description,
		inputSchema: options.inputSchema,
		modelInputSchema: options.modelInputSchema,
		enforceModelInput: options.enforceModelInput,
		validationErrorHint: options.validationErrorHint,
		...(options.truncatedInputHint !== undefined
			? { truncatedInputHint: options.truncatedInputHint }
			: {}),
		...(options.malformedInputHint !== undefined
			? { malformedInputHint: options.malformedInputHint }
			: {}),
		...(options.largeStringArguments !== undefined
			? { largeStringArguments: options.largeStringArguments }
			: {}),
		tier: options.tier,
		...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
		...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
		...(options.commandArgument !== undefined ? { commandArgument: options.commandArgument } : {}),
		...(options.commandDialect !== undefined ? { commandDialect: options.commandDialect } : {}),
		...(options.pathArgument !== undefined ? { pathArgument: options.pathArgument } : {}),
		...(options.urlArgument !== undefined ? { urlArgument: options.urlArgument } : {}),
		...(options.sandboxEscapeArgument !== undefined
			? { sandboxEscapeArgument: options.sandboxEscapeArgument }
			: {}),
		...(options.presentCall ? { presentCall: options.presentCall } : {}),
		...(options.presentResult ? { presentResult: options.presentResult } : {}),
		...(options.outputSchema !== undefined ? { outputSchema: options.outputSchema } : {}),
		...(options.terminal !== undefined ? { terminal: options.terminal } : {}),
		...(options.executionBarrier !== undefined
			? { executionBarrier: options.executionBarrier }
			: {}),
		category: options.category,
		permissions: options.permissions,
		isReadOnly:
			typeof options.readOnly === 'function' ? options.readOnly : () => options.readOnly as boolean,
		isDestructive:
			typeof options.destructive === 'function'
				? options.destructive
				: constantDestructive(options.destructive as boolean),
		isConcurrencySafe: () => options.concurrencySafe,

		async execute(input: TInput, context: ToolContext): Promise<ToolResult> {
			try {
				return await options.execute(input, context)
			} catch (err) {
				const message = toErrorMessage(err)
				return {
					success: false,
					output: '',
					error: `${options.name} failed: ${message}`,
				}
			}
		},
	}
}
