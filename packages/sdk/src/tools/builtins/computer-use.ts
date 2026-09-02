import { z } from 'zod'
import type {
	ComputerUseAction,
	ComputerUseCapabilities,
	ComputerUseHost,
	ComputerUseOutcomeUnknown,
	ComputerUseResult,
} from '../../types/computer-use/index.js'
import type { ToolDefinition, ToolResult } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'

export const COMPUTER_USE_TOOL_NAME = 'computer_use' as const

// ---------------------------------------------------------------------------
// Input schema — discriminated union matching ComputerUseAction
// ---------------------------------------------------------------------------

const pointSchema = z.object({
	x: z.number().int(),
	y: z.number().int(),
})

const mouseButtonSchema = z.enum(['left', 'right', 'middle'])

const actionSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('screenshot') }),
	z.object({ type: z.literal('cursor_position') }),
	z.object({ type: z.literal('mouse_move'), to: pointSchema }),
	z.object({ type: z.literal('mouse_click'), at: pointSchema, button: mouseButtonSchema }),
	z.object({
		type: z.literal('mouse_drag'),
		from: pointSchema,
		to: pointSchema,
		button: mouseButtonSchema,
	}),
	z.object({
		type: z.literal('scroll'),
		at: pointSchema,
		direction: z.enum(['up', 'down', 'left', 'right']),
		amount: z.number().int().positive(),
	}),
	z.object({ type: z.literal('type_text'), text: z.string() }),
	z.object({ type: z.literal('key'), keys: z.string() }),
])

/**
 * The provider-facing shape is deliberately flat.
 *
 * The runtime schema above is the authoritative contract: it knows which
 * fields each action requires. Rendering that discriminated union produces a
 * root `anyOf`, however, and some custom-tool wires reject root combinators
 * even when every branch is an object. A model can still see every field and
 * every action here; incomplete combinations are rejected by `actionSchema`
 * before the host is called, with the recovery hint below.
 */
const pointModelInputSchema = {
	type: 'object',
	properties: {
		x: { type: 'integer' },
		y: { type: 'integer' },
	},
	required: ['x', 'y'],
	additionalProperties: false,
} as const

const modelInputSchema: Record<string, unknown> = {
	type: 'object',
	properties: {
		type: {
			type: 'string',
			enum: [
				'screenshot',
				'cursor_position',
				'mouse_move',
				'mouse_click',
				'mouse_drag',
				'scroll',
				'type_text',
				'key',
			],
			description:
				'Desktop action. screenshot and cursor_position need no other fields; mouse_move needs to; mouse_click needs at and button; mouse_drag needs from, to, and button; scroll needs at, direction, and amount; type_text needs text; key needs keys.',
		},
		to: pointModelInputSchema,
		at: pointModelInputSchema,
		from: pointModelInputSchema,
		button: { type: 'string', enum: ['left', 'right', 'middle'] },
		direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
		amount: { type: 'integer', description: 'Positive integer scroll distance.' },
		text: { type: 'string', description: 'Literal text to type.' },
		keys: {
			type: 'string',
			description: 'Key or key chord to press, for example ENTER or CTRL+R.',
		},
	},
	required: ['type'],
	additionalProperties: false,
}

/**
 * The tool's input, inferred from its schema.
 *
 * Exported because `createComputerUseTool` returns a `ToolDefinition<ActionInput>`
 * and a consumer typing that variable, or writing a wrapper around it, had no
 * name for the parameter — the type was module-private while the function
 * carrying it was public.
 */
export type ActionInput = z.infer<typeof actionSchema>

const DESTRUCTIVE_ACTION_TYPES = new Set<ComputerUseAction['type']>([
	'mouse_click',
	'mouse_drag',
	'type_text',
	'key',
	'scroll',
])

function requiredCapability(type: ComputerUseAction['type']): keyof ComputerUseCapabilities | null {
	switch (type) {
		case 'screenshot':
			return 'screenshot'
		case 'cursor_position':
			return 'cursorPosition'
		case 'mouse_move':
		case 'mouse_click':
		case 'mouse_drag':
		case 'scroll':
			return 'mouse'
		case 'type_text':
		case 'key':
			return 'keyboard'
		default:
			return null
	}
}

function buildDescription(host: ComputerUseHost): string {
	const caps = host.capabilities
	const available: string[] = []
	if (caps.screenshot) available.push('screenshot')
	if (caps.cursorPosition) available.push('cursor_position')
	if (caps.mouse) available.push('mouse_move, mouse_click, mouse_drag, scroll')
	if (caps.keyboard) available.push('type_text, key')
	const unavailable: string[] = []
	if (!caps.screenshot) unavailable.push('screenshot')
	if (!caps.cursorPosition) unavailable.push('cursor_position')
	if (!caps.mouse) unavailable.push('mouse')
	if (!caps.keyboard) unavailable.push('keyboard')

	const lines = [
		`Controls the user's desktop on a ${caps.displayServer} host. Use to take screenshots and drive mouse/keyboard input for GUI tasks.`,
		`Available actions: ${available.join('; ') || 'none'}.`,
	]
	if (unavailable.length > 0) {
		lines.push(
			caps.unavailableReason
				? `Unavailable on this host: ${unavailable.join(', ')} — ${caps.unavailableReason} Do not retry; tell the user.`
				: `Unavailable on this host: ${unavailable.join(', ')}.`,
		)
	}
	lines.push(
		'Coordinates are in logical pixels from the top-left of the primary display. Call getDisplayGeometry through screenshot output before clicking to confirm bounds.',
	)
	return lines.join(' ')
}

function pointLabel(point: { readonly x: number; readonly y: number }): string {
	return `(${point.x}, ${point.y})`
}

function quotedText(value: string): string {
	const oneLine = value.replace(/\s+/g, ' ')
	const visible = oneLine.length > 64 ? `${oneLine.slice(0, 63)}…` : oneLine
	return JSON.stringify(visible)
}

/** Human activity text; the raw action union remains the model-facing input. */
function actionLabel(input: ActionInput): string {
	switch (input.type) {
		case 'screenshot':
			return 'Capture screenshot'
		case 'cursor_position':
			return 'Read cursor position'
		case 'mouse_move':
			return `Move pointer to ${pointLabel(input.to)}`
		case 'mouse_click':
			return `Click ${input.button} at ${pointLabel(input.at)}`
		case 'mouse_drag':
			return `Drag ${input.button} from ${pointLabel(input.from)} to ${pointLabel(input.to)}`
		case 'scroll':
			return `Scroll ${input.direction} ${input.amount} at ${pointLabel(input.at)}`
		case 'type_text':
			return `Type ${quotedText(input.text)}`
		case 'key':
			return `Press ${input.keys}`
	}
}

function resultToToolResult(result: ComputerUseResult): ToolResult {
	switch (result.type) {
		case 'screenshot': {
			const { data, mimeType, width, height } = result.result
			// `output` used to BE the base64 payload, which meant the model
			// received 400 KB–2.7 MB of undecodable characters as text —
			// roughly 100k–670k tokens — and could not see the screen at
			// all. The image now travels as a content block; `output` keeps
			// the short human/transcript-facing description.
			return {
				success: true,
				output: `Screenshot captured (${width}x${height}, ${mimeType}).`,
				content: [{ type: 'image', data: data.toString('base64'), mediaType: mimeType }],
				data: { mimeType, width, height, encoding: 'base64' },
			}
		}
		case 'cursor_position':
			return {
				success: true,
				output: JSON.stringify(result.point),
				data: result.point,
			}
		case 'ok':
			return { success: true, output: 'ok' }
	}
}

function isOutcomeUnknown(
	value: unknown,
	action: ComputerUseAction['type'],
): value is ComputerUseOutcomeUnknown {
	if (typeof value !== 'object' || value === null) return false
	const candidate = value as Partial<ComputerUseOutcomeUnknown>
	return (
		candidate.code === 'computer_use_outcome_unknown' &&
		candidate.action === action &&
		candidate.outcome === 'unknown' &&
		candidate.retrySafety === 'unsafe' &&
		typeof candidate.timedOut === 'boolean' &&
		typeof candidate.exitCode === 'number' &&
		Number.isInteger(candidate.exitCode) &&
		typeof candidate.message === 'string' &&
		candidate.message.length > 0
	)
}

function unknownOutcomeToToolResult(error: ComputerUseOutcomeUnknown): ToolResult {
	return {
		success: false,
		output: '',
		error: error.message,
		data: {
			code: error.code,
			action: error.action,
			outcome: error.outcome,
			retrySafety: error.retrySafety,
			timedOut: error.timedOut,
			exitCode: error.exitCode,
		},
	}
}

/**
 * Factory: given a ComputerUseHost (provided by the consumer — e.g.
 * @namzu/computer-use's SubprocessComputerUseHost), returns a ToolDefinition
 * that routes the discriminated action to the host and maps results back to
 * the SDK's ToolResult shape.
 *
 * The tool's description reflects the host's frozen capabilities, and any
 * action targeting an unavailable capability is rejected with a clear error
 * rather than hanging or failing silently.
 *
 * @example
 * ```ts
 * import { SubprocessComputerUseHost } from '@namzu/computer-use'
 * import { createComputerUseTool } from '@namzu/sdk'
 *
 * const host = new SubprocessComputerUseHost()
 * await host.initialize?.()
 * registry.register(createComputerUseTool(host))
 * ```
 */
export function createComputerUseTool(host: ComputerUseHost): ToolDefinition<ActionInput> {
	return defineTool({
		name: COMPUTER_USE_TOOL_NAME,
		description: buildDescription(host),
		inputSchema: actionSchema,
		modelInputSchema: structuredClone(modelInputSchema),
		validationErrorHint:
			'Action requirements: mouse_move needs "to"; mouse_click needs "at" and "button"; mouse_drag needs "from", "to", and "button"; scroll needs "at", "direction", and positive "amount"; type_text needs "text"; key needs "keys".',
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: (input: ActionInput) => DESTRUCTIVE_ACTION_TYPES.has(input.type),
		concurrencySafe: false,
		presentCall: (input) => ({
			kind: 'generic',
			label: actionLabel(input),
			presentation: 'activity',
		}),
		presentResult: (_input, result) =>
			result.success && result.output.trim().toLowerCase() === 'ok'
				? { kind: 'generic', label: result.output, visibility: 'hidden' }
				: undefined,

		async execute(input, _context): Promise<ToolResult> {
			const required = requiredCapability(input.type)
			if (required !== null && host.capabilities[required] !== true) {
				return {
					success: false,
					output: '',
					error: `computer_use: action "${input.type}" requires capability "${required}" which is not available on this host (displayServer=${host.capabilities.displayServer}).${host.capabilities.unavailableReason ? ` ${host.capabilities.unavailableReason} Do not retry; tell the user.` : ''}`,
				}
			}
			try {
				const result = await host.execute(input as ComputerUseAction)
				return resultToToolResult(result)
			} catch (error) {
				if (isOutcomeUnknown(error, input.type)) {
					return unknownOutcomeToToolResult(error)
				}
				throw error
			}
		},
	})
}
