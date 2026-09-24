import { z } from 'zod'
import { resolveProviderCapabilities } from '../../provider/capabilities.js'
import type {
	ComputerUseAction,
	ComputerUseCapabilities,
	ComputerUseHost,
	ComputerUseOutcomeUnknown,
	Point,
	Rect,
	ScreenshotResult,
	WindowInfo,
} from '../../types/computer-use/index.js'
import type { ToolResultBlock } from '../../types/message/index.js'
import type { LLMProvider } from '../../types/provider/index.js'
import type { ToolContext, ToolDefinition, ToolResult } from '../../types/tool/index.js'
import { sleep } from '../../utils/backoff.js'
import { defineTool } from '../defineTool.js'
import {
	type ScreenshotFrame,
	ScreenshotFrames,
	assumedDisplay,
	desktopRectOnImage,
	pointOnImage,
	toDisplayPoint,
	toDisplayRect,
	toImagePoint,
} from './computer-use-coordinates.js'
import {
	type FittedImage,
	STANDARD_SCREENSHOT_LIMITS,
	type ScreenshotLimits,
	cropAndFitPng,
	fitPng,
	pngSize,
} from './computer-use-image.js'

export {
	HIGH_RES_SCREENSHOT_LIMITS,
	STANDARD_SCREENSHOT_LIMITS,
	screenshotTargetSize,
} from './computer-use-image.js'
export type { ImageSize, ScreenshotLimits } from './computer-use-image.js'

export const COMPUTER_USE_TOOL_NAME = 'computer_use' as const

const DEFAULT_SETTLE_MS = 500
const DEFAULT_MAX_BATCH_ACTIONS = 20
const DEFAULT_MAX_WAIT_MS = 10_000
const MAX_LISTED_WINDOWS = 50

/**
 * How `createComputerUseTool` sizes screenshots, paces actions and bounds a
 * batch. Every field is optional.
 */
export interface ComputerUseToolOptions {
	/**
	 * What every screenshot and zoom image is fitted to before the model sees
	 * it. Default {@link STANDARD_SCREENSHOT_LIMITS}, which every current vision
	 * model takes without a further resize; {@link HIGH_RES_SCREENSHOT_LIMITS}
	 * only when every model the session can reach is on that tier.
	 */
	readonly screenshotLimits?: ScreenshotLimits
	/**
	 * Milliseconds to wait after an action before the screenshot it returns,
	 * so a menu has opened or a page has started to paint. Default 500.
	 */
	readonly settleMs?: number
	/**
	 * Return a fresh screenshot after every call that changed something.
	 * Default true. Off, a model has to ask for one — an extra round trip per
	 * action, which is what this exists to remove.
	 */
	readonly screenshotAfterActions?: boolean
	/** Most actions one `batch` may carry. Default 20. */
	readonly maxBatchActions?: number
	/** Longest single `wait`, in milliseconds. Default 10 000. */
	readonly maxWaitMs?: number
	/**
	 * Why computer use cannot work in this session although the host could —
	 * typically that the provider cannot put an image in a tool result, so the
	 * model would never see a screenshot (see
	 * {@link computerUseUnavailableReason}). Set, the tool mounts as a
	 * diagnostic: its description says why and every call is refused without
	 * touching the host.
	 */
	readonly unavailableReason?: string
}

/**
 * Why `provider` cannot drive `computer_use`, or undefined when it can.
 *
 * The tool's only way to show the model the screen is an image in a tool
 * result. A driver that declares `supportsToolResultImages: false` replaces
 * that image with a line of text, so the model acts on a screen it has never
 * seen while every call reports success. Pass the answer to
 * {@link ComputerUseToolOptions.unavailableReason}.
 */
export function computerUseUnavailableReason(
	provider: Pick<LLMProvider, 'id' | 'capabilities'>,
): string | undefined {
	if (resolveProviderCapabilities(provider).supportsToolResultImages) return undefined
	return `The ${provider.id} provider cannot return images in tool results, so the model would never see a screenshot. Use a provider that can (for example Anthropic, Codex or Google) for computer use.`
}

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const pointSchema = z.object({
	x: z.number().int(),
	y: z.number().int(),
})

const regionSchema = z.object({
	x: z.number().int(),
	y: z.number().int(),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
})

const mouseButtonSchema = z.enum(['left', 'right', 'middle'])
const screenshotIdSchema = z.string().min(1).optional()

const cursorPositionSchema = z.object({ type: z.literal('cursor_position') })
const mouseMoveSchema = z.object({ type: z.literal('mouse_move'), to: pointSchema })
const mouseClickSchema = z.object({
	type: z.literal('mouse_click'),
	at: pointSchema,
	button: mouseButtonSchema,
})
const mouseDragSchema = z.object({
	type: z.literal('mouse_drag'),
	from: pointSchema,
	to: pointSchema,
	button: mouseButtonSchema,
})
const scrollSchema = z.object({
	type: z.literal('scroll'),
	at: pointSchema,
	direction: z.enum(['up', 'down', 'left', 'right']),
	amount: z.number().int().positive(),
})
const typeTextSchema = z.object({ type: z.literal('type_text'), text: z.string() })
const keySchema = z.object({ type: z.literal('key'), keys: z.string() })
const waitSchema = z.object({ type: z.literal('wait'), ms: z.number().int().nonnegative() })
const listWindowsSchema = z.object({ type: z.literal('list_windows') })
const focusWindowSchema = z.object({
	type: z.literal('focus_window'),
	window_id: z.string().min(1),
})

/** What a batch may carry: everything but the image-returning actions and another batch. */
const batchItemSchema = z.discriminatedUnion('type', [
	cursorPositionSchema,
	mouseMoveSchema,
	mouseClickSchema,
	mouseDragSchema,
	scrollSchema,
	typeTextSchema,
	keySchema,
	waitSchema,
	listWindowsSchema,
	focusWindowSchema,
])

const withFrame = { screenshot_id: screenshotIdSchema }

const actionSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('screenshot') }),
	z.object({ type: z.literal('zoom'), region: regionSchema, ...withFrame }),
	cursorPositionSchema.extend(withFrame),
	mouseMoveSchema.extend(withFrame),
	mouseClickSchema.extend(withFrame),
	mouseDragSchema.extend(withFrame),
	scrollSchema.extend(withFrame),
	typeTextSchema.extend(withFrame),
	keySchema.extend(withFrame),
	waitSchema.extend(withFrame),
	listWindowsSchema.extend(withFrame),
	focusWindowSchema.extend(withFrame),
	z.object({
		type: z.literal('batch'),
		actions: z.array(batchItemSchema).min(1),
		...withFrame,
	}),
])

/**
 * The tool's input, inferred from its schema: one action, or
 * `{ type: 'batch', actions: [...] }`.
 *
 * Exported because `createComputerUseTool` returns a `ToolDefinition<ActionInput>`
 * and a consumer typing that variable, or writing a wrapper around it, had no
 * name for the parameter — the type was module-private while the function
 * carrying it was public.
 */
export type ActionInput = z.infer<typeof actionSchema>
type BatchItem = z.infer<typeof batchItemSchema>
type ToolActionType = ActionInput['type']

const HOST_ACTIONS: readonly ComputerUseAction['type'][] = [
	'screenshot',
	'cursor_position',
	'mouse_move',
	'mouse_click',
	'mouse_drag',
	'scroll',
	'type_text',
	'key',
]

const ALL_ACTIONS: readonly ToolActionType[] = [
	'screenshot',
	'zoom',
	'cursor_position',
	'mouse_move',
	'mouse_click',
	'mouse_drag',
	'scroll',
	'type_text',
	'key',
	'wait',
	'list_windows',
	'focus_window',
	'batch',
]

/** Observations: they change nothing on the desktop. */
const READ_ONLY_ACTIONS = new Set<string>([
	'screenshot',
	'zoom',
	'cursor_position',
	'wait',
	'list_windows',
])

const DESTRUCTIVE_ACTIONS = new Set<string>([
	'mouse_click',
	'mouse_drag',
	'type_text',
	'key',
	'scroll',
])

const IMAGE_ACTIONS = new Set<string>(['screenshot', 'zoom', 'batch'])

/** A single action's whole result when it only acted: `<label>: done`, then its screenshot. */
const ACKNOWLEDGEMENT = /^[^\n]*: done(\nScreenshot s\d+ \(\d+x\d+\)\.)?$/

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function batchActions(input: unknown): readonly unknown[] | null {
	if (!isRecord(input) || input.type !== 'batch') return null
	return Array.isArray(input.actions) ? input.actions : []
}

/** Read-only when every action is: a batch with one click in it is not. Unknown shapes are not. */
function isReadOnlyInput(input: unknown): boolean {
	const actions = batchActions(input)
	if (actions)
		return (
			actions.length > 0 &&
			actions.every((item) => isRecord(item) && READ_ONLY_ACTIONS.has(String(item.type)))
		)
	return isRecord(input) && READ_ONLY_ACTIONS.has(String(input.type))
}

function isDestructiveInput(input: unknown): boolean {
	const actions = batchActions(input)
	if (actions)
		return actions.some((item) => !isRecord(item) || DESTRUCTIVE_ACTIONS.has(String(item.type)))
	return isRecord(input) && DESTRUCTIVE_ACTIONS.has(String(input.type))
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

function requiredCapability(type: string): keyof ComputerUseCapabilities | null {
	switch (type) {
		case 'screenshot':
		case 'zoom':
		case 'wait':
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
		case 'list_windows':
		case 'focus_window':
			return 'windows'
		default:
			return null
	}
}

function hostActionAvailable(
	caps: ComputerUseCapabilities,
	action: ComputerUseAction['type'],
): boolean {
	const required = requiredCapability(action)
	return (
		(required === null || caps[required] === true) &&
		(caps.supportedActions === undefined || caps.supportedActions.includes(action)) &&
		(action !== 'mouse_click' || caps.mouseClickButtons?.length !== 0) &&
		(action !== 'mouse_drag' || caps.mouseDragButtons?.length !== 0)
	)
}

function availableActions(host: ComputerUseHost, caps: ComputerUseCapabilities): ToolActionType[] {
	const screenshot = hostActionAvailable(caps, 'screenshot')
	const windows =
		caps.windows === true &&
		typeof host.listWindows === 'function' &&
		typeof host.focusWindow === 'function'
	const available = ALL_ACTIONS.filter((action) => {
		switch (action) {
			case 'zoom':
			case 'wait':
				return screenshot
			case 'list_windows':
			case 'focus_window':
				return windows
			case 'batch':
				return false
			default:
				return hostActionAvailable(caps, action)
		}
	})
	if (available.some((action) => !IMAGE_ACTIONS.has(action))) available.push('batch')
	return available
}

function unavailableHostActions(caps: ComputerUseCapabilities): string[] {
	const unavailable: string[] = []
	if (!caps.screenshot) unavailable.push('screenshot')
	if (!caps.cursorPosition) unavailable.push('cursor_position')
	if (!caps.mouse) unavailable.push('mouse')
	if (!caps.keyboard) unavailable.push('keyboard')
	if (caps.supportedActions) {
		for (const action of HOST_ACTIONS) {
			if (!hostActionAvailable(caps, action) && !unavailable.includes(action))
				unavailable.push(action)
		}
	}
	return unavailable
}

// ---------------------------------------------------------------------------
// Model-facing description and schema
// ---------------------------------------------------------------------------

function buildDescription(
	host: ComputerUseHost,
	caps: ComputerUseCapabilities,
	settings: ResolvedSettings,
): string {
	const available = availableActions(host, caps)
	const unavailable = unavailableHostActions(caps)
	const lines = [
		`Controls the user's desktop on a ${caps.displayServer} host: screenshots, mouse and keyboard, for GUI tasks.`,
		`Available actions: ${available.join('; ') || 'none'}.`,
	]
	if (unavailable.length > 0) {
		lines.push(
			caps.unavailableReason
				? `Unavailable on this host: ${unavailable.join(', ')} — ${caps.unavailableReason} Do not retry; tell the user.`
				: `Unavailable on this host: ${unavailable.join(', ')}.`,
		)
	}
	if (!available.includes('screenshot')) return finish(lines, caps, available)
	lines.push(
		'Coordinates: every x/y you send is a pixel of the most recent screenshot this tool returned — origin at its top-left, x to the right, y down — never a screen pixel. Each screenshot states its id and size (for example "s3: 1456x819"); stay inside it. The tool maps your coordinates onto the display. To aim at an earlier screenshot, pass its id as screenshot_id.',
		'Take a screenshot before your first click.',
	)
	if (settings.screenshotAfterActions)
		lines.push(
			`After any action that changes something, the tool waits ${settings.settleMs} ms and returns a new screenshot — do not call screenshot again after acting.`,
		)
	lines.push(
		'zoom returns a closer, sharper view of region {x, y, width, height} of the screenshot; your coordinates still refer to the screenshot, not to the zoomed image.',
		`wait pauses for ms milliseconds (at most ${settings.maxWaitMs} per call, a batch's waits together) and then shows the screen.`,
	)
	if (available.includes('batch'))
		lines.push(
			`batch: {"type":"batch","actions":[...]} runs up to ${settings.maxBatchActions} actions in order, stops at the first one that fails, and returns one screenshot at the end. Use it for steps whose targets you can already see (click a field, type, press ENTER). A batch cannot contain screenshot or zoom.`,
		)
	if (available.includes('list_windows'))
		lines.push(
			'list_windows names the open windows with their ids; focus_window brings one to the front.',
		)
	lines.push(
		'Typing and keys go to whichever window has focus: confirm on a screenshot that the right window is in front before type_text or key.',
	)
	return finish(lines, caps, available)
}

function finish(
	lines: string[],
	caps: ComputerUseCapabilities,
	available: readonly string[],
): string {
	if (caps.mouseClickButtons && available.includes('mouse_click'))
		lines.push(`Click buttons: ${caps.mouseClickButtons.join(', ') || 'none'}.`)
	if (caps.mouseDragButtons && available.includes('mouse_drag'))
		lines.push(`Drag buttons: ${caps.mouseDragButtons.join(', ') || 'none'}.`)
	return lines.join(' ')
}

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
function pointModelSchema(description?: string): Record<string, unknown> {
	return {
		type: 'object',
		...(description ? { description } : {}),
		properties: {
			x: { type: 'integer' },
			y: { type: 'integer' },
		},
		required: ['x', 'y'],
		additionalProperties: false,
	}
}

const ACTION_REQUIREMENTS: Readonly<Record<ToolActionType, string>> = {
	screenshot: 'screenshot needs no other fields',
	zoom: 'zoom needs region',
	cursor_position: 'cursor_position needs no other fields',
	mouse_move: 'mouse_move needs to',
	mouse_click: 'mouse_click needs at and button',
	mouse_drag: 'mouse_drag needs from, to, and button',
	scroll: 'scroll needs at, direction, and amount',
	type_text: 'type_text needs text',
	key: 'key needs keys',
	wait: 'wait needs ms',
	list_windows: 'list_windows needs no other fields',
	focus_window: 'focus_window needs window_id',
	batch: 'batch needs actions',
}

function hostModelSchema(
	host: ComputerUseHost,
	caps: ComputerUseCapabilities,
	settings: ResolvedSettings,
): Record<string, unknown> {
	// An unavailable host remains a diagnostic tool. Avoid invalid empty enums
	// on provider wires; every execution is still refused before host access.
	const offered = availableActions(host, caps)
	const actions = offered.length > 0 ? offered : ALL_ACTIONS.filter((a) => a !== 'batch')
	const items = actions.filter((action) => !IMAGE_ACTIONS.has(action))
	const buttons = new Set<string>()
	if (actions.includes('mouse_click'))
		for (const button of caps.mouseClickButtons ?? ['left', 'right', 'middle']) buttons.add(button)
	if (actions.includes('mouse_drag'))
		for (const button of caps.mouseDragButtons ?? ['left', 'right', 'middle']) buttons.add(button)
	const buttonEnum = buttons.size > 0 ? [...buttons] : ['left', 'right', 'middle']

	const fieldSchemas = (forItems: boolean): Record<string, unknown> => {
		const present = forItems ? items : actions
		const fields: Record<string, unknown> = {
			to: pointModelSchema(),
			at: pointModelSchema(),
			from: pointModelSchema(),
			button: { type: 'string', enum: buttonEnum },
			direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
			amount: { type: 'integer', description: 'Positive integer scroll distance.' },
			text: { type: 'string', description: 'Literal text to type.' },
			keys: {
				type: 'string',
				description: 'Key or key chord to press, for example ENTER or CTRL+R.',
			},
			ms: {
				type: 'integer',
				description: `Milliseconds to wait, 0 to ${settings.maxWaitMs}.`,
			},
		}
		if (present.includes('focus_window'))
			fields.window_id = { type: 'string', description: 'A window id from list_windows.' }
		if (!forItems && present.includes('zoom'))
			fields.region = {
				type: 'object',
				description: 'Area of the screenshot to zoom into, in its pixels.',
				properties: {
					x: { type: 'integer' },
					y: { type: 'integer' },
					width: { type: 'integer' },
					height: { type: 'integer' },
				},
				required: ['x', 'y', 'width', 'height'],
				additionalProperties: false,
			}
		return fields
	}

	const properties: Record<string, unknown> = {
		type: {
			type: 'string',
			enum: actions,
			description: `Desktop action. ${actions.map((action) => ACTION_REQUIREMENTS[action]).join('; ')}.`,
		},
		...fieldSchemas(false),
	}
	if (actions.includes('batch'))
		properties.actions = {
			type: 'array',
			minItems: 1,
			maxItems: settings.maxBatchActions,
			description: `For type batch: up to ${settings.maxBatchActions} actions run in order (no screenshot, zoom or batch inside).`,
			items: {
				type: 'object',
				properties: {
					type: { type: 'string', enum: items },
					...fieldSchemas(true),
				},
				required: ['type'],
				additionalProperties: false,
			},
		}
	properties.screenshot_id = {
		type: 'string',
		description:
			'Optional id of the screenshot your coordinates were read from, such as s3. Defaults to the latest.',
	}
	return {
		type: 'object',
		properties,
		required: ['type'],
		additionalProperties: false,
	}
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function pointLabel(point: { readonly x: number; readonly y: number }): string {
	return `(${point.x}, ${point.y})`
}

function quotedText(value: string): string {
	const oneLine = value.replace(/\s+/g, ' ')
	const visible = oneLine.length > 64 ? `${oneLine.slice(0, 63)}…` : oneLine
	return JSON.stringify(visible)
}

function waitLabel(ms: number): string {
	return ms >= 1000 ? `Wait ${Number((ms / 1000).toFixed(1))} s` : `Wait ${ms} ms`
}

/** Human activity text for one action; the raw input remains the model-facing record. */
function itemLabel(input: BatchItem | ActionInput): string {
	switch (input.type) {
		case 'screenshot':
			return 'Capture screenshot'
		case 'zoom':
			return `Zoom into ${input.region.width}x${input.region.height} at ${pointLabel(input.region)}`
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
		case 'wait':
			return waitLabel(input.ms)
		case 'list_windows':
			return 'List windows'
		case 'focus_window':
			return `Focus window ${input.window_id}`
		case 'batch':
			return batchLabel(input.actions)
	}
}

function batchLabel(actions: readonly BatchItem[]): string {
	const parts = actions.map((item) => itemLabel(item))
	const head = `${actions.length} desktop action${actions.length === 1 ? '' : 's'}`
	const joined = parts.join(' · ')
	return joined.length > 240 ? `${head}: ${joined.slice(0, 239)}…` : `${head}: ${joined}`
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface ResolvedSettings {
	readonly limits: ScreenshotLimits
	readonly settleMs: number
	readonly screenshotAfterActions: boolean
	readonly maxBatchActions: number
	readonly maxWaitMs: number
}

function resolveSettings(options: ComputerUseToolOptions): ResolvedSettings {
	const count = (value: number | undefined, fallback: number, min: number, name: string) => {
		if (value === undefined) return fallback
		if (!Number.isSafeInteger(value) || value < min)
			throw new RangeError(`createComputerUseTool: ${name} must be an integer ≥ ${min}`)
		return value
	}
	const limits = options.screenshotLimits ?? STANDARD_SCREENSHOT_LIMITS
	if (
		!Number.isSafeInteger(limits.maxLongEdge) ||
		!Number.isSafeInteger(limits.maxTiles) ||
		limits.maxLongEdge < 28 ||
		limits.maxTiles < 1
	)
		throw new RangeError(
			'createComputerUseTool: screenshotLimits needs an integer maxLongEdge ≥ 28 and maxTiles ≥ 1',
		)
	return {
		limits,
		settleMs: count(options.settleMs, DEFAULT_SETTLE_MS, 0, 'settleMs'),
		screenshotAfterActions: options.screenshotAfterActions ?? true,
		maxBatchActions: count(
			options.maxBatchActions,
			DEFAULT_MAX_BATCH_ACTIONS,
			1,
			'maxBatchActions',
		),
		maxWaitMs: count(options.maxWaitMs, DEFAULT_MAX_WAIT_MS, 0, 'maxWaitMs'),
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

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/** One planned step: validated, coordinates already mapped, ready to run. */
interface PlannedStep {
	readonly item: BatchItem
	readonly label: string
	readonly mutating: boolean
	run(signal: AbortSignal | undefined): Promise<string>
}

type StepRecord =
	| { readonly label: string; readonly status: 'done'; readonly note: string }
	| {
			readonly label: string
			readonly status: 'failed'
			readonly error: string
			readonly unknown?: ComputerUseOutcomeUnknown
	  }
	| { readonly label: string; readonly status: 'not run' }

class StepFailure extends Error {
	constructor(
		message: string,
		readonly unknown?: ComputerUseOutcomeUnknown,
	) {
		super(message)
	}
}

interface Capture {
	readonly frame: ScreenshotFrame
	readonly image: FittedImage
}

/**
 * Factory: given a ComputerUseHost (provided by the consumer — e.g.
 * @namzu/computer-use's SubprocessComputerUseHost), returns the
 * `computer_use` tool.
 *
 * Every screenshot is fitted to the model's image limits and numbered;
 * every coordinate the model sends is a pixel of one of those screenshots and
 * is mapped onto the host's display. Actions that change something return a
 * fresh screenshot after a short settle delay, and `batch` runs several in
 * one call. The description and schema reflect the host's frozen
 * capabilities, and any action targeting an unavailable capability is
 * rejected before the host is touched.
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
export function createComputerUseTool(
	host: ComputerUseHost,
	options: ComputerUseToolOptions = {},
): ToolDefinition<ActionInput> {
	const settings = resolveSettings(options)
	const caps: ComputerUseCapabilities = options.unavailableReason
		? {
				...host.capabilities,
				screenshot: false,
				mouse: false,
				keyboard: false,
				cursorPosition: false,
				clipboard: false,
				windows: false,
				regionCapture: false,
				uiTree: false,
				unavailableReason: options.unavailableReason,
			}
		: host.capabilities
	const frames = new ScreenshotFrames()
	const available = new Set<string>(availableActions(host, caps))

	const refusal = (type: string): string | null => {
		const required = requiredCapability(type)
		const why = caps.unavailableReason
			? ` ${caps.unavailableReason} Do not retry; tell the user.`
			: ''
		if (required !== null && caps[required] !== true)
			return `computer_use: action "${type}" requires capability "${required}" which is not available on this host (displayServer=${caps.displayServer}).${why}`
		if (!available.has(type))
			return `computer_use: action "${type}" is not supported on this host.${why}`
		return null
	}

	/** Capture the display, fit it, and number it. */
	const capture = async (): Promise<Capture> => {
		const result = await host.execute({ type: 'screenshot' })
		if (result.type !== 'screenshot')
			throw new Error(`computer_use: the host answered a screenshot with "${result.type}"`)
		const shot = result.result
		const image = await fitPng(shot.data, settings.limits)
		const display = shot.display ?? assumedDisplay(image.sourceWidth, image.sourceHeight)
		return { frame: frames.record(image, display), image }
	}

	const frameFor = (id: string | undefined): ScreenshotFrame => {
		if (id !== undefined) {
			const frame = frames.get(id)
			if (!frame)
				throw new StepFailure(
					`there is no screenshot ${id} (the latest is ${frames.latest()?.id ?? 'none'}); take a screenshot and use its coordinates`,
				)
			return frame
		}
		const latest = frames.latest()
		if (!latest)
			throw new StepFailure(
				'no screenshot has been taken yet, so there is nothing for coordinates to refer to; take a screenshot first',
			)
		return latest
	}

	/**
	 * Keys go to whichever window has focus, and a model that has not looked
	 * does not know which one that is — the terminal running this agent is
	 * the usual answer. When the host can show the screen, look first.
	 */
	const requireLook = (): void => {
		if (available.has('screenshot') && !frames.latest())
			throw new StepFailure(
				'no screenshot has been taken yet, so nothing shows which window has focus and would receive the keys; take a screenshot first',
			)
	}

	const mapPoint = (frame: ScreenshotFrame, point: Point, field: string): Point => {
		if (!pointOnImage(frame, point))
			throw new StepFailure(
				`${field} ${pointLabel(point)} is outside screenshot ${frame.id}, which is ${frame.imageWidth}x${frame.imageHeight} (x 0–${frame.imageWidth - 1}, y 0–${frame.imageHeight - 1}); coordinates are pixels of the screenshot, not of the screen`,
			)
		return toDisplayPoint(frame, point)
	}

	const runHost = async (action: ComputerUseAction): Promise<string> => {
		try {
			const result = await host.execute(action)
			if (result.type === 'cursor_position') {
				const frame = frames.latest()
				if (!frame) return `at display pixel ${pointLabel(result.point)}`
				return `at ${pointLabel(toImagePoint(frame, result.point))} in ${frame.id}`
			}
			return 'done'
		} catch (error) {
			if (isOutcomeUnknown(error, action.type)) throw new StepFailure(error.message, error)
			throw new StepFailure(errorText(error))
		}
	}

	const plan = (item: BatchItem, frameId: string | undefined): PlannedStep => {
		const denied = refusal(item.type)
		if (denied) throw new StepFailure(denied)
		const label = itemLabel(item)
		const mutating = !READ_ONLY_ACTIONS.has(item.type)
		const step = (run: PlannedStep['run']): PlannedStep => ({ item, label, mutating, run })
		switch (item.type) {
			case 'cursor_position':
				frameFor(frameId)
				return step(() => runHost({ type: 'cursor_position' }))
			case 'mouse_move': {
				const frame = frameFor(frameId)
				const to = mapPoint(frame, item.to, 'to')
				return step(() => runHost({ type: 'mouse_move', to }))
			}
			case 'mouse_click': {
				const buttons = caps.mouseClickButtons
				if (buttons && !buttons.includes(item.button))
					throw new StepFailure(
						`computer_use: action "mouse_click" does not support button "${item.button}" on this host.`,
					)
				const frame = frameFor(frameId)
				const at = mapPoint(frame, item.at, 'at')
				return step(() => runHost({ type: 'mouse_click', at, button: item.button }))
			}
			case 'mouse_drag': {
				const buttons = caps.mouseDragButtons
				if (buttons && !buttons.includes(item.button))
					throw new StepFailure(
						`computer_use: action "mouse_drag" does not support button "${item.button}" on this host.`,
					)
				const frame = frameFor(frameId)
				const from = mapPoint(frame, item.from, 'from')
				const to = mapPoint(frame, item.to, 'to')
				return step(() => runHost({ type: 'mouse_drag', from, to, button: item.button }))
			}
			case 'scroll': {
				const frame = frameFor(frameId)
				const at = mapPoint(frame, item.at, 'at')
				return step(() =>
					runHost({ type: 'scroll', at, direction: item.direction, amount: item.amount }),
				)
			}
			case 'type_text':
				requireLook()
				return step(() => runHost({ type: 'type_text', text: item.text }))
			case 'key':
				requireLook()
				return step(() => runHost({ type: 'key', keys: item.keys }))
			case 'wait':
				return step(async (signal) => {
					await sleep(item.ms, signal)
					return 'done'
				})
			case 'list_windows':
				return step(() => listWindows())
			case 'focus_window':
				return step(async () => {
					let outcome: Awaited<ReturnType<NonNullable<ComputerUseHost['focusWindow']>>>
					try {
						outcome = await (host.focusWindow as NonNullable<ComputerUseHost['focusWindow']>)(
							item.window_id,
						)
					} catch (error) {
						throw new StepFailure(errorText(error))
					}
					if (!outcome.ok)
						throw new StepFailure(
							`window ${item.window_id} could not be brought to the front; ${outcome.focusedId ? `window ${outcome.focusedId} is in front` : 'the window in front could not be read'}`,
						)
					return 'done'
				})
		}
	}

	const listWindows = async (): Promise<string> => {
		let windows: readonly WindowInfo[]
		try {
			windows = await (host.listWindows as NonNullable<ComputerUseHost['listWindows']>)()
		} catch (error) {
			throw new StepFailure(errorText(error))
		}
		if (windows.length === 0) return 'no windows are open'
		const frame = frames.latest()
		const lines = windows.slice(0, MAX_LISTED_WINDOWS).map((window) => {
			const where = frame
				? (() => {
						const rect = window.minimized ? null : desktopRectOnImage(frame, window.bounds)
						return rect
							? `at ${pointLabel(rect)} ${rect.width}x${rect.height} in ${frame.id}`
							: window.minimized
								? 'minimized'
								: `not on the display of ${frame.id}`
					})()
				: window.minimized
					? 'minimized'
					: ''
			return [
				`- ${window.id}`,
				JSON.stringify(window.title),
				`${window.app} (pid ${window.pid})`,
				...(window.focused ? ['focused'] : []),
				...(where ? [where] : []),
			].join(' · ')
		})
		const more =
			windows.length > MAX_LISTED_WINDOWS
				? [`… and ${windows.length - MAX_LISTED_WINDOWS} more`]
				: []
		return `${windows.length} window${windows.length === 1 ? '' : 's'}, front to back:\n${[...lines, ...more].join('\n')}`
	}

	const describeFrame = (frame: ScreenshotFrame): string => {
		const { display } = frame
		const scaled = frame.imageWidth !== display.width || frame.imageHeight !== display.height
		return scaled
			? `Screenshot ${frame.id}: ${frame.imageWidth}x${frame.imageHeight} pixels, showing the ${display.width}x${display.height} display. Send coordinates in this image's pixels (x 0–${frame.imageWidth - 1}, y 0–${frame.imageHeight - 1}); the tool maps them onto the display.`
			: `Screenshot ${frame.id}: ${frame.imageWidth}x${frame.imageHeight} pixels, the display at full size. Send coordinates in this image's pixels (x 0–${frame.imageWidth - 1}, y 0–${frame.imageHeight - 1}).`
	}

	const frameData = (frame: ScreenshotFrame) => ({
		id: frame.id,
		width: frame.imageWidth,
		height: frame.imageHeight,
		display: frame.display,
		mimeType: 'image/png' as const,
		encoding: 'base64' as const,
	})

	const pin = (frame: ScreenshotFrame): NonNullable<ToolResult['workingState']> => [
		{
			key: 'computer_use.screenshot',
			text: `computer_use coordinates are pixels of screenshot ${frame.id} (${frame.imageWidth}x${frame.imageHeight}), origin top-left.`,
		},
	]

	const imageBlock = (image: FittedImage): ToolResultBlock => ({
		type: 'image',
		data: image.data.toString('base64'),
		mediaType: 'image/png',
	})

	const screenshotResult = (shot: Capture): ToolResult => ({
		success: true,
		output: `Screenshot ${shot.frame.id} captured (${shot.frame.imageWidth}x${shot.frame.imageHeight} of the ${shot.frame.display.width}x${shot.frame.display.height} display).`,
		content: [{ type: 'text', text: describeFrame(shot.frame) }, imageBlock(shot.image)],
		data: { screenshot: frameData(shot.frame) },
		workingState: pin(shot.frame),
	})

	const zoom = async (input: Extract<ActionInput, { type: 'zoom' }>): Promise<ToolResult> => {
		const frame = frameFor(input.screenshot_id)
		const { region } = input
		const onImage = {
			x: Math.max(0, region.x),
			y: Math.max(0, region.y),
			width: Math.min(region.x + region.width, frame.imageWidth) - Math.max(0, region.x),
			height: Math.min(region.y + region.height, frame.imageHeight) - Math.max(0, region.y),
		}
		if (onImage.width <= 0 || onImage.height <= 0)
			throw new StepFailure(
				`region ${region.width}x${region.height} at ${pointLabel(region)} is outside screenshot ${frame.id} (${frame.imageWidth}x${frame.imageHeight})`,
			)
		const rect = toDisplayRect(frame, onImage) as Rect
		let fitted: FittedImage
		if (caps.regionCapture === true && typeof host.captureRegion === 'function') {
			const piece = await host.captureRegion(rect)
			fitted = await fitPng(piece.data, settings.limits)
		} else {
			const result = await host.execute({ type: 'screenshot' })
			if (result.type !== 'screenshot')
				throw new Error(`computer_use: the host answered a screenshot with "${result.type}"`)
			const full: ScreenshotResult = result.result
			const size = pngSize(full.data)
			const display = full.display ?? assumedDisplay(size.width, size.height)
			if (display.width !== frame.display.width || display.height !== frame.display.height)
				throw new StepFailure(
					`the display is now ${display.width}x${display.height}, not what ${frame.id} showed; take a new screenshot`,
				)
			// The capture's own pixels, in case a host captures at another scale than it reports.
			const sx = size.width / display.width
			const sy = size.height / display.height
			const left = Math.floor(rect.x * sx)
			const top = Math.floor(rect.y * sy)
			fitted = await cropAndFitPng(
				full.data,
				{
					x: left,
					y: top,
					width: Math.max(1, Math.min(size.width, Math.ceil((rect.x + rect.width) * sx)) - left),
					height: Math.max(1, Math.min(size.height, Math.ceil((rect.y + rect.height) * sy)) - top),
				},
				settings.limits,
			)
		}
		const detail = fitted.width / onImage.width
		const text = `Zoom of ${onImage.width}x${onImage.height} at ${pointLabel(onImage)} in ${frame.id}, shown at ${fitted.width}x${fitted.height} (${detail.toFixed(1)}x the detail of ${frame.id}). Coordinates for actions still refer to ${frame.id} (${frame.imageWidth}x${frame.imageHeight}), not to this image.`
		return {
			success: true,
			output: `Zoomed into ${onImage.width}x${onImage.height} at ${pointLabel(onImage)} of ${frame.id} (shown at ${fitted.width}x${fitted.height}).`,
			content: [{ type: 'text', text }, imageBlock(fitted)],
			data: {
				zoom: {
					screenshot: frame.id,
					region: onImage,
					width: fitted.width,
					height: fitted.height,
					mimeType: 'image/png',
					encoding: 'base64',
				},
			},
		}
	}

	/** Run actions in order, stop at the first failure, then show the screen once. */
	const runSteps = async (
		items: readonly BatchItem[],
		frameId: string | undefined,
		context: ToolContext | undefined,
		single: boolean,
	): Promise<ToolResult> => {
		if (items.length > settings.maxBatchActions)
			return {
				success: false,
				output: '',
				error: `computer_use: a batch carries at most ${settings.maxBatchActions} actions; got ${items.length}. Nothing was run.`,
			}
		// Waits share one budget, so a batch stays well inside the tool's
		// deadline however its waits are split.
		const waited = items.reduce((total, item) => total + (item.type === 'wait' ? item.ms : 0), 0)
		if (waited > settings.maxWaitMs)
			return {
				success: false,
				output: '',
				error: `computer_use: ${single ? 'wait is' : "a batch's waits add up to"} at most ${settings.maxWaitMs} ms; got ${waited}. Nothing was run.`,
			}
		// Plan everything before doing anything: a refusal or a coordinate off
		// the screenshot in step 5 should not arrive after steps 1–4 changed
		// the desktop.
		const planned: PlannedStep[] = []
		for (const [index, item] of items.entries()) {
			try {
				planned.push(plan(item, frameId))
			} catch (error) {
				const message = errorText(error)
				return {
					success: false,
					output: '',
					error: single
						? message
						: `computer_use: action ${index + 1} of ${items.length} (${itemLabel(item)}) cannot run: ${message}. Nothing was run.`,
				}
			}
		}

		const signal = context?.abortSignal
		const records: StepRecord[] = []
		let changed = false
		let failure: { index: number; error: string; unknown?: ComputerUseOutcomeUnknown } | undefined
		for (const [index, step] of planned.entries()) {
			if (signal?.aborted) {
				failure = { index, error: 'cancelled before it started' }
				records.push({ label: step.label, status: 'failed', error: failure.error })
				break
			}
			try {
				const note = await step.run(signal)
				records.push({ label: step.label, status: 'done', note })
				if (step.mutating) changed = true
			} catch (error) {
				const unknown = error instanceof StepFailure ? error.unknown : undefined
				const message = signal?.aborted ? 'cancelled' : errorText(error)
				failure = { index, error: message, ...(unknown ? { unknown } : {}) }
				records.push({
					label: step.label,
					status: 'failed',
					error: message,
					...(unknown ? { unknown } : {}),
				})
				if (unknown) changed = true
				break
			}
		}
		for (const step of planned.slice(records.length))
			records.push({ label: step.label, status: 'not run' })

		// The screen after the batch: after anything that may have changed it,
		// and after a wait, whose whole point is to look again.
		const looks =
			settings.screenshotAfterActions &&
			available.has('screenshot') &&
			(changed || planned.some((step) => step.item.type === 'wait')) &&
			!signal?.aborted
		let shot: Capture | undefined
		let shotError: string | undefined
		if (looks) {
			try {
				await sleep(settings.settleMs, signal)
				shot = await capture()
			} catch (error) {
				shotError = signal?.aborted ? 'cancelled' : errorText(error)
			}
		}

		const summary = (record: StepRecord, index: number): string => {
			const n = single ? '' : `${index + 1}. `
			switch (record.status) {
				case 'done':
					return `${n}${record.label}: ${record.note}`
				case 'failed':
					return `${n}${record.label}: failed — ${record.error}`
				case 'not run':
					return `${n}${record.label}: not run`
			}
		}
		const header = single
			? []
			: failure
				? [
						`Batch stopped at action ${failure.index + 1} of ${planned.length}; ${planned.length - failure.index - 1} not run.`,
					]
				: [`Batch: all ${planned.length} actions done.`]
		const stepLines = records.map(summary)
		const shotLines = shot
			? [describeFrame(shot.frame)]
			: shotError
				? [`The screenshot after acting failed: ${shotError}. Take one before acting again.`]
				: []
		const unknownLines = failure?.unknown ? [failure.unknown.message] : []
		const text = [...header, ...stepLines, ...unknownLines, ...shotLines].join('\n')
		const output = [
			...header,
			...stepLines,
			...(shot
				? [`Screenshot ${shot.frame.id} (${shot.frame.imageWidth}x${shot.frame.imageHeight}).`]
				: []),
		].join('\n')
		const data = {
			steps: records.map((record) =>
				record.status === 'failed'
					? { label: record.label, status: record.status, error: record.error }
					: { label: record.label, status: record.status },
			),
			...(shot ? { screenshot: frameData(shot.frame) } : {}),
			...(failure?.unknown
				? {
						code: failure.unknown.code,
						action: failure.unknown.action,
						outcome: failure.unknown.outcome,
						retrySafety: failure.unknown.retrySafety,
						timedOut: failure.unknown.timedOut,
						exitCode: failure.unknown.exitCode,
					}
				: {}),
		}
		const content: ToolResultBlock[] = [{ type: 'text', text }]
		if (shot) content.push(imageBlock(shot.image))
		const result: ToolResult = {
			success: failure === undefined,
			output,
			content,
			data,
			...(shot ? { workingState: pin(shot.frame) } : {}),
		}
		if (failure)
			result.error = failure.unknown
				? failure.unknown.message
				: single
					? `computer_use failed: ${failure.error}`
					: `Batch stopped at action ${failure.index + 1} of ${planned.length} (${planned[failure.index]?.label}): ${failure.error}`
		return result
	}

	return defineTool({
		name: COMPUTER_USE_TOOL_NAME,
		description: buildDescription(host, caps, settings),
		inputSchema: actionSchema,
		modelInputSchema: hostModelSchema(host, caps, settings),
		validationErrorHint: `Action requirements: ${ALL_ACTIONS.map((action) => ACTION_REQUIREMENTS[action]).join('; ')}. A batch is {"type":"batch","actions":[...]} with at most ${settings.maxBatchActions} actions and no screenshot, zoom or batch inside.`,
		category: 'custom',
		permissions: [],
		readOnly: (input: ActionInput) => isReadOnlyInput(input),
		destructive: (input: ActionInput) => isDestructiveInput(input),
		concurrencySafe: false,
		presentCall: (input) => ({
			kind: 'generic',
			label: itemLabel(input),
			presentation: 'activity',
		}),
		// Decided from the result alone: a host may present a finished call
		// without its input (the CLI passes `{}`). An action that only reports
		// "done" — and the screenshot that followed it, which is for the model —
		// adds nothing to the call row; observations, batches and failures do.
		presentResult: (_input, result) =>
			result.success && ACKNOWLEDGEMENT.test(result.output)
				? { kind: 'generic', label: result.output, visibility: 'hidden' }
				: undefined,

		async execute(input, context): Promise<ToolResult> {
			const denied = refusal(input.type)
			if (denied) return { success: false, output: '', error: denied }
			try {
				switch (input.type) {
					case 'screenshot':
						return screenshotResult(await capture())
					case 'zoom':
						return await zoom(input)
					case 'batch':
						return await runSteps(input.actions, input.screenshot_id, context, false)
					default: {
						const { screenshot_id: frameId, ...item } = input
						return await runSteps([item as BatchItem], frameId, context, true)
					}
				}
			} catch (error) {
				if (error instanceof StepFailure)
					return { success: false, output: '', error: `computer_use failed: ${error.message}` }
				throw error
			}
		},
	})
}
