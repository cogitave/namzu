import { z } from 'zod'
import type {
	ComputerUseAction,
	ComputerUseCapabilities,
	ComputerUseHost,
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

type ActionInput = z.infer<typeof actionSchema>

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
		lines.push(`Unavailable on this host: ${unavailable.join(', ')}.`)
	}
	lines.push(
		'Coordinates are in logical pixels from the top-left of the primary display. Call getDisplayGeometry through screenshot output before clicking to confirm bounds.',
	)
	return lines.join(' ')
}

function resultToToolResult(result: ComputerUseResult): ToolResult {
	switch (result.type) {
		case 'screenshot': {
			const { data, mimeType, width, height } = result.result
			return {
				success: true,
				output: data.toString('base64'),
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
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: (input: ActionInput) => DESTRUCTIVE_ACTION_TYPES.has(input.type),
		concurrencySafe: false,

		async execute(input, _context): Promise<ToolResult> {
			const required = requiredCapability(input.type)
			if (required !== null && host.capabilities[required] !== true) {
				return {
					success: false,
					output: '',
					error: `computer_use: action "${input.type}" requires capability "${required}" which is not available on this host (displayServer=${host.capabilities.displayServer}).`,
				}
			}
			const result = await host.execute(input as ComputerUseAction)
			return resultToToolResult(result)
		},
	})
}
