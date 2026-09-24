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
	UiActResult,
	UiElement,
	UiElementAction,
	UiSnapshot,
	WindowInfo,
} from '../../types/computer-use/index.js'
import type { ToolResultBlock } from '../../types/message/index.js'
import type { LLMProvider } from '../../types/provider/index.js'
import type { ToolContext, ToolDefinition, ToolResult } from '../../types/tool/index.js'
import { sleep } from '../../utils/backoff.js'
import { defineTool } from '../defineTool.js'
import { neutralizeEnvelopeDelimiter, wrapUntrusted } from '../untrusted-envelope.js'
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
/** The most of a ui_snapshot the model is shown, in characters (about 4 000 tokens). */
const MAX_UI_SNAPSHOT_CHARS = 14_000

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

// Left when omitted: a model asked to "click the Start button" often leaves
// the button out, and refusing that cost a whole round trip for nothing.
const mouseButtonSchema = z.enum(['left', 'right', 'middle']).default('left')
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
const UI_ACTIONS = [
	'invoke',
	'set_value',
	'toggle',
	'select',
	'expand',
	'collapse',
	'focus',
	'scroll_into_view',
] as const satisfies readonly UiElementAction[]
const uiSnapshotSchema = z.object({
	type: z.literal('ui_snapshot'),
	window_id: z.string().min(1).optional(),
})
const uiActSchema = z.object({
	type: z.literal('ui_act'),
	ref: z.string().min(1),
	action: z.enum(UI_ACTIONS),
	value: z.string().optional(),
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
	uiActSchema,
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
	uiSnapshotSchema,
	uiActSchema.extend(withFrame),
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
 * Exported because `createComputerUseTool` returns a `ToolDefinition<ActionInput>` (a `ComputerUseTool`)
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
	'ui_snapshot',
	'ui_act',
	'batch',
]

/** Observations: they change nothing on the desktop. */
const READ_ONLY_ACTIONS = new Set<string>([
	'screenshot',
	'zoom',
	'cursor_position',
	'wait',
	'list_windows',
	'ui_snapshot',
])

const DESTRUCTIVE_ACTIONS = new Set<string>([
	'mouse_click',
	'mouse_drag',
	'type_text',
	'key',
	'scroll',
	'ui_act',
])

/** Observations that show the model what is on the screen, on their own. */
const SCREEN_OBSERVATIONS = new Set<string>(['screenshot', 'zoom', 'list_windows', 'ui_snapshot'])

/**
 * Terminal applications, by the process name a host reports in
 * `WindowInfo.app` (on Windows without `.exe`). Keys are not typed into these.
 */
const TERMINAL_APPS =
	/^(WindowsTerminal|OpenConsole|conhost|cmd|powershell|pwsh|wsl|mintty|wezterm(-gui)?|alacritty|Hyper|Tabby|kitty|ConEmu(64)?|putty|Terminal|iTerm2?|gnome-terminal(-server)?|konsole|xterm|xfce4-terminal|tilix|terminator|foot|ghostty|Warp)$/i

/** Actions a batch cannot carry: the ones that return an image or a tree, and batch itself. */
const OUTSIDE_BATCH = new Set<string>(['screenshot', 'zoom', 'ui_snapshot', 'batch'])

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
		case 'ui_snapshot':
		case 'ui_act':
			return 'uiTree'
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
	const uiTree =
		caps.uiTree === true &&
		typeof host.uiSnapshot === 'function' &&
		typeof host.uiAct === 'function'
	const available = ALL_ACTIONS.filter((action) => {
		switch (action) {
			case 'zoom':
			case 'wait':
				return screenshot
			case 'list_windows':
			case 'focus_window':
				return windows
			case 'ui_snapshot':
			case 'ui_act':
				return uiTree
			case 'batch':
				return false
			default:
				return hostActionAvailable(caps, action)
		}
	})
	if (available.some((action) => !OUTSIDE_BATCH.has(action))) available.push('batch')
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
			`batch: {"type":"batch","actions":[...]} runs up to ${settings.maxBatchActions} actions in order, stops at the first one that fails, and returns one screenshot at the end. Every call costs a model round trip of several seconds, so put the steps you can already predict into one batch (click a field, type, press ENTER) rather than one call each — but end the batch at any step that should bring up a new window, and look before typing into it. A batch cannot contain screenshot${available.includes('ui_snapshot') ? ', zoom or ui_snapshot' : ' or zoom'}.`,
		)
	if (
		caps.displayServer === 'win32' &&
		available.includes('key') &&
		available.includes('type_text')
	)
		lines.push(
			'To start a Windows program, a shell command (Start-Process notepad, or cmd.exe /c start calc) is surest when you have a shell tool. The Start menu searches by display names in the system language, and ENTER on a name it does not find opens a web search in the browser.',
		)
	if (available.includes('list_windows'))
		lines.push(
			'list_windows names the open windows with their ids; focus_window brings one to the front.',
		)
	if (available.includes('ui_snapshot'))
		lines.push(
			`ui_snapshot {window_id} reads a window's controls (its accessibility tree) as text, each control you can act on with a ref such as e12; without window_id it reads the window in front. ui_act {ref, action, value} acts on one control: invoke (press a button, open a menu item), set_value (replace a field's text with value), toggle, select, expand, collapse. Prefer ui_act to clicking pixels when the control is in the tree: it does not depend on coordinates or on which window is in front, and a batch of ui_act steps (for example pressing several buttons) runs in one call. Refs are valid only until the next ui_snapshot; take a new one after the window changes.`,
		)
	lines.push(
		'Typing and keys go to whichever window has focus: confirm on a screenshot that the right window is in front before type_text or key.',
	)
	if (available.includes('list_windows'))
		lines.push(
			'type_text and key are refused while a terminal window is in front — usually the one running this agent, or the user’s own; bring the window you mean to the front first (focus_window, or click it).',
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
			x: { type: 'integer', description: 'Horizontal pixel coordinate, from the left edge.' },
			y: { type: 'integer', description: 'Vertical pixel coordinate, from the top edge.' },
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
	mouse_click: 'mouse_click needs at (button defaults to left)',
	mouse_drag: 'mouse_drag needs from and to (button defaults to left)',
	scroll: 'scroll needs at, direction, and amount',
	type_text: 'type_text needs text',
	key: 'key needs keys',
	wait: 'wait needs ms',
	list_windows: 'list_windows needs no other fields',
	focus_window: 'focus_window needs window_id',
	ui_snapshot: 'ui_snapshot takes an optional window_id',
	ui_act: 'ui_act needs ref and action, and value for set_value',
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
	const items = actions.filter((action) => !OUTSIDE_BATCH.has(action))
	const buttons = new Set<string>()
	if (actions.includes('mouse_click'))
		for (const button of caps.mouseClickButtons ?? ['left', 'right', 'middle']) buttons.add(button)
	if (actions.includes('mouse_drag'))
		for (const button of caps.mouseDragButtons ?? ['left', 'right', 'middle']) buttons.add(button)
	const buttonEnum = buttons.size > 0 ? [...buttons] : ['left', 'right', 'middle']

	const fieldSchemas = (forItems: boolean): Record<string, unknown> => {
		const present = forItems ? items : actions
		const fields: Record<string, unknown> = {
			to: pointModelSchema(
				'Destination point: where mouse_move moves the cursor to, or where mouse_drag releases.',
			),
			at: pointModelSchema('Point the action happens at: where to click, or where to scroll.'),
			from: pointModelSchema('Drag start point, for mouse_drag.'),
			button: { type: 'string', enum: buttonEnum, description: 'Mouse button; left when omitted.' },
			direction: {
				type: 'string',
				enum: ['up', 'down', 'left', 'right'],
				description: 'Which way to scroll.',
			},
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
		if (present.includes('focus_window') || (!forItems && present.includes('ui_snapshot')))
			fields.window_id = { type: 'string', description: 'A window id from list_windows.' }
		if (present.includes('ui_act')) {
			fields.ref = {
				type: 'string',
				description: 'A ref from the latest ui_snapshot, such as e12.',
			}
			fields.action = {
				type: 'string',
				enum: [...UI_ACTIONS],
				description: 'What ui_act does to the control.',
			}
			fields.value = { type: 'string', description: 'The text set_value puts in the control.' }
		}
		if (!forItems && present.includes('zoom'))
			fields.region = {
				type: 'object',
				description: 'Area of the screenshot to zoom into, in its pixels.',
				properties: {
					x: { type: 'integer', description: 'Left edge of the region, in screenshot pixels.' },
					y: { type: 'integer', description: 'Top edge of the region, in screenshot pixels.' },
					width: { type: 'integer', description: 'Width of the region, in screenshot pixels.' },
					height: { type: 'integer', description: 'Height of the region, in screenshot pixels.' },
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
			description: `For type batch: up to ${settings.maxBatchActions} actions run in order (no screenshot, zoom, ui_snapshot or batch inside).`,
			items: {
				type: 'object',
				properties: {
					type: {
						type: 'string',
						enum: items,
						description: 'This batched action.',
					},
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

/** What a ui_act does, as a verb phrase over the control's description. */
function uiActLabel(
	input: { readonly ref: string; readonly action: UiElementAction; readonly value?: string },
	describe?: (ref: string) => string | undefined,
): string {
	const target = describe?.(input.ref) ?? input.ref
	switch (input.action) {
		case 'invoke':
			return `Press ${target}`
		case 'set_value':
			return `Set ${target} to ${quotedText(input.value ?? '')}`
		case 'toggle':
			return `Toggle ${target}`
		case 'select':
			return `Select ${target}`
		case 'expand':
			return `Expand ${target}`
		case 'collapse':
			return `Collapse ${target}`
		case 'focus':
			return `Focus ${target}`
		case 'scroll_into_view':
			return `Scroll to ${target}`
	}
}

/**
 * Human activity text for one action; the raw input remains the model-facing
 * record. `describe` names a ui_act ref's control when the tool knows it.
 */
function itemLabel(
	input: BatchItem | ActionInput,
	describe?: (ref: string) => string | undefined,
): string {
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
		case 'ui_snapshot':
			return input.window_id
				? `Read the controls of window ${input.window_id}`
				: 'Read the controls of the front window'
		case 'ui_act':
			return uiActLabel(input, describe)
		case 'batch':
			return batchLabel(input.actions, describe)
	}
}

function batchLabel(
	actions: readonly BatchItem[],
	describe?: (ref: string) => string | undefined,
): string {
	const parts = actions.map((item) => itemLabel(item, describe))
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

/** A control of the latest ui_snapshot: the host's ref and what it was. */
interface UiRef {
	readonly hostRef: string
	readonly element: UiElement
}

/**
 * The `computer_use` tool, with one question a host's review screen can ask
 * of it.
 */
export interface ComputerUseTool extends ToolDefinition<ActionInput> {
	/**
	 * What a `ui_act` ref names in the latest `ui_snapshot` — `Button "Beş"
	 * (e30)` — or undefined for a ref it does not hold. For a host that shows
	 * a person the call before it runs; the words are the application's, so a
	 * host shows them as text and nothing more.
	 *
	 * @experimental Follows the UI-tree surface; see `ComputerUseCapabilities.uiTree`.
	 */
	describeUiRef(ref: string): string | undefined
}

/** Whether a call sends the screen to the provider (see `ToolDefinition.capturesScreen`). */
function capturesScreenInput(input: unknown, screenshotAfterActions: boolean): boolean {
	const items = batchActions(input) ?? [input]
	return items.some((item) => {
		if (!isRecord(item)) return true
		const type = String(item.type)
		if (SCREEN_OBSERVATIONS.has(type)) return true
		if (type === 'cursor_position') return false
		// Everything else is followed by a screenshot unless that is switched off.
		return screenshotAfterActions
	})
}

function safeRole(role: string): string {
	return /^[A-Za-z][\w-]{0,39}$/.test(role) ? role : 'Element'
}

/** `Button "Beş"`: the control's role and name, one line, cut to fit. */
function uiElementText(element: UiElement): string {
	const name = element.name.trim()
	return name.length > 0 ? `${safeRole(element.role)} ${quotedText(name)}` : safeRole(element.role)
}

/**
 * One line of a ui_snapshot: `[e12] Button "Beş" (disabled) [invoke] @(212, 488)`.
 * The ref and position are the tool's; the rest is the application's, and
 * sits inside the untrusted frame.
 */
function uiElementLine(
	element: UiElement,
	ref: string | undefined,
	frame: ScreenshotFrame | undefined,
): string {
	const parts = [`${ref ? `[${ref}] ` : ''}${uiElementText(element)}`]
	if (element.value !== undefined && element.value !== element.name)
		parts.push(`value=${quotedText(element.value)}`)
	const states = (element.states ?? []).filter((state) => /^[a-z_]{1,24}$/.test(state))
	if (states.length > 0) parts.push(`(${states.join(', ')})`)
	if (ref) {
		const actions = (element.actions ?? []).filter((action) =>
			(UI_ACTIONS as readonly string[]).includes(action),
		)
		if (actions.length > 0) parts.push(`[${actions.join(', ')}]`)
		const at = frame && element.bounds ? centreOnImage(frame, element.bounds) : undefined
		if (at) parts.push(`@${pointLabel(at)}`)
	}
	return neutralizeEnvelopeDelimiter(parts.join(' '))
}

/** The centre of a virtual-desktop rectangle on a screenshot, or undefined when it is not on its display. */
function centreOnImage(frame: ScreenshotFrame, bounds: Rect): Point | undefined {
	const x = Math.floor(bounds.x + bounds.width / 2) - frame.display.x
	const y = Math.floor(bounds.y + bounds.height / 2) - frame.display.y
	if (x < 0 || y < 0 || x >= frame.display.width || y >= frame.display.height) return undefined
	return toImagePoint(frame, { x, y })
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
): ComputerUseTool {
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

	// The controls of the latest ui_snapshot, by the ref the model was shown.
	// Refs count up across snapshots, so a ref from an earlier one is never
	// silently a different control of the latest: it is simply not here.
	let uiRefs = new Map<string, UiRef>()
	let uiSnapshots = 0
	let uiRefCount = 0
	const describeUiRef = (ref: string): string | undefined => {
		const entry = uiRefs.get(ref)
		return entry ? `${uiElementText(entry.element)} (${ref})` : undefined
	}
	const label = (input: BatchItem | ActionInput): string => itemLabel(input, describeUiRef)

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
		const mutating = !READ_ONLY_ACTIONS.has(item.type)
		const step = (run: PlannedStep['run']): PlannedStep => ({
			item,
			label: label(item),
			mutating,
			run,
		})
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
			case 'ui_act': {
				const entry = uiRefs.get(item.ref)
				if (!entry)
					throw new StepFailure(
						uiSnapshots === 0
							? `there is no ${item.ref}: no ui_snapshot has been taken yet; take one and use its refs`
							: `${item.ref} is not a control of the latest ui_snapshot (u${uiSnapshots}); refs are valid only until the next ui_snapshot, so use the refs it showed`,
					)
				const offered = entry.element.actions
				if (offered && offered.length > 0 && !offered.includes(item.action))
					throw new StepFailure(
						`${describeUiRef(item.ref)} offers ${offered.join(', ')}, not ${item.action}`,
					)
				if (item.action === 'set_value' && item.value === undefined)
					throw new StepFailure('set_value needs value, the text to put in the control')
				return step(async () => {
					let outcome: UiActResult
					try {
						outcome = await (host.uiAct as NonNullable<ComputerUseHost['uiAct']>)(
							entry.hostRef,
							item.action,
							item.value,
						)
					} catch (error) {
						throw new StepFailure(errorText(error))
					}
					if (!outcome.ok)
						throw new StepFailure(
							outcome.detail ?? `${item.action} did not take effect on ${describeUiRef(item.ref)}`,
						)
					return outcome.detail ? `done (${outcome.detail})` : 'done'
				})
			}
		}
	}

	/** Read one window's controls, number the ones the model can act on, and show them. */
	const uiSnapshot = async (
		input: Extract<ActionInput, { type: 'ui_snapshot' }>,
	): Promise<ToolResult> => {
		let snapshot: UiSnapshot
		try {
			snapshot = await (host.uiSnapshot as NonNullable<ComputerUseHost['uiSnapshot']>)(
				input.window_id,
			)
		} catch (error) {
			throw new StepFailure(errorText(error))
		}
		uiSnapshots += 1
		const id = `u${uiSnapshots}`
		const refs = new Map<string, UiRef>()
		const frame = frames.latest()
		const lines: string[] = []
		let chars = 0
		let shown = 0
		let total = 0
		let cut = false
		const visit = (element: UiElement, depth: number): void => {
			total += 1
			const actionable = element.ref.length > 0
			const children = element.children ?? []
			// A nameless control nobody can act on says nothing by itself; its
			// children still stand, one level up.
			const silent = !actionable && element.name.trim().length === 0 && element.value === undefined
			if (!silent && !cut) {
				const ref = actionable ? `e${uiRefCount + 1}` : undefined
				const line = `${'  '.repeat(depth)}${uiElementLine(element, ref, frame)}`
				if (chars + line.length + 1 > MAX_UI_SNAPSHOT_CHARS) {
					cut = true
				} else {
					lines.push(line)
					chars += line.length + 1
					shown += 1
					if (ref) {
						uiRefCount += 1
						refs.set(ref, { hostRef: element.ref, element })
					}
				}
			}
			for (const child of children) visit(child, silent ? depth : depth + 1)
		}
		visit(snapshot.root, 0)
		uiRefs = refs
		const window =
			snapshot.windowId && /^[\w.:-]{1,64}$/.test(snapshot.windowId) ? snapshot.windowId : undefined
		const header = [
			`UI snapshot ${id}${window ? ` of window ${window}` : ''}: ${shown} controls shown, ${refs.size} with a ref you can pass to ui_act. Refs are valid until the next ui_snapshot.`,
			...(frame
				? [
						`@(x, y) is a control's centre on screenshot ${frame.id}, for a click when ui_act cannot reach it.`,
					]
				: []),
		]
		// The window's title and application, when the tree's own root does not
		// already say them; inside the frame, since an application sets both.
		const about = [
			...(snapshot.app !== undefined ? [`Application ${quotedText(snapshot.app)}`] : []),
			...(snapshot.title !== undefined && snapshot.title !== snapshot.root.name
				? [`Window title ${quotedText(snapshot.title)}`]
				: []),
		]
		const body = [...about, ...lines].join('\n')
		const footer =
			cut || snapshot.truncated
				? [
						cut
							? `The tree was cut at ${MAX_UI_SNAPSHOT_CHARS} characters after ${shown} of ${total} controls. Read a smaller window, or use a screenshot for the rest.`
							: 'The host stopped reading the tree before it ended; controls further down are missing. Use a screenshot for the rest.',
					]
				: []
		const text = [
			...header,
			wrapUntrusted(
				{
					kind: 'desktop-ui',
					...(window ? { attributes: { window } } : {}),
					provenance:
						"The accessibility tree of a window on the user's desktop, as the host read it. Names and values are whatever the application shows, which can include text anyone wrote.",
				},
				body,
			),
			...footer,
		].join('\n')
		return {
			success: true,
			output: header[0] ?? '',
			content: [{ type: 'text', text }],
			data: {
				uiSnapshot: {
					id,
					...(window ? { windowId: window } : {}),
					controls: shown,
					refs: refs.size,
					truncated: cut || snapshot.truncated === true,
				},
			},
		}
	}

	/**
	 * Keys and text go to the window in front, and a terminal there — the
	 * one running this agent, or the user's own — turns a model's typing into
	 * a command line: ENTER runs it or sends it. A session had a WIN+R that
	 * did not open the Run dialog type "notepad" and ENTER into the user's
	 * terminal, and submitted their half-typed message. So with a window list
	 * the tool reads what is in front before typing, and refuses a terminal.
	 * Without one it cannot tell, and the description's advice stands alone.
	 */
	const refuseTerminalInFront = async (): Promise<void> => {
		if (!available.has('list_windows')) return
		let windows: readonly WindowInfo[]
		try {
			windows = await (host.listWindows as NonNullable<ComputerUseHost['listWindows']>)()
		} catch (error) {
			throw new StepFailure(
				`the window in front could not be read, so nothing was typed: ${errorText(error)}`,
			)
		}
		const front = windows.find((window) => window.focused)
		if (front && TERMINAL_APPS.test(front.app))
			throw new StepFailure(
				`a terminal is in front (${front.app}, window ${front.id}), so nothing was typed: computer_use never sends keys or text to a terminal. Bring the window you mean to the front (focus_window, or click it) and try again; for a command, use a shell tool instead`,
			)
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
		// Titles are whatever an application puts there — a web page's title in
		// a browser window — so the list is framed as material, not direction.
		return `${windows.length} window${windows.length === 1 ? '' : 's'}, front to back:\n${wrapUntrusted(
			{
				kind: 'desktop-windows',
				provenance:
					"The open windows on the user's desktop, as the host listed them. Titles are whatever each application shows, which can include text anyone wrote.",
			},
			[...lines, ...more].join('\n'),
		)}`
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

	// Said once, beside the first screenshot, where it is read: a model that
	// has just seen the screen reaches for pixels unless told the host can
	// name the controls.
	const firstLookHint = (frame: ScreenshotFrame): string[] =>
		frame.id === 's1' && available.has('ui_snapshot')
			? [
					'This host can also read a window’s controls: list_windows, then ui_snapshot {window_id}, then ui_act by ref (a batch of them for several buttons) — surer than clicking pixels in an ordinary application.',
				]
			: []

	const screenshotResult = (shot: Capture): ToolResult => ({
		success: true,
		output: `Screenshot ${shot.frame.id} captured (${shot.frame.imageWidth}x${shot.frame.imageHeight} of the ${shot.frame.display.width}x${shot.frame.display.height} display).`,
		content: [
			{ type: 'text', text: [describeFrame(shot.frame), ...firstLookHint(shot.frame)].join('\n') },
			imageBlock(shot.image),
		],
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
						: `computer_use: action ${index + 1} of ${items.length} (${label(item)}) cannot run: ${message}. Nothing was run.`,
				}
			}
		}

		const signal = context?.abortSignal
		const records: StepRecord[] = []
		let changed = false
		let failure: { index: number; error: string; unknown?: ComputerUseOutcomeUnknown } | undefined
		// Whether the window in front was checked since the last step that could
		// have changed it. Typing does not move focus; everything else may.
		let frontChecked = false
		for (const [index, step] of planned.entries()) {
			if (signal?.aborted) {
				failure = { index, error: 'cancelled before it started' }
				records.push({ label: step.label, status: 'failed', error: failure.error })
				break
			}
			try {
				const keyboard = step.item.type === 'type_text' || step.item.type === 'key'
				if (keyboard && !frontChecked) {
					await refuseTerminalInFront()
					frontChecked = true
				}
				if (step.item.type !== 'type_text') frontChecked = false
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

	// Whether a call sends the screen to the provider: an observation, or an
	// action that returns a screenshot afterwards. A diagnostic tool that can
	// reach nothing captures nothing.
	const observes =
		available.has('screenshot') || available.has('list_windows') || available.has('ui_snapshot')
	const capturesScreen = (input: ActionInput): boolean =>
		observes && capturesScreenInput(input, settings.screenshotAfterActions)

	const tool = defineTool({
		name: COMPUTER_USE_TOOL_NAME,
		description: buildDescription(host, caps, settings),
		inputSchema: actionSchema,
		modelInputSchema: hostModelSchema(host, caps, settings),
		validationErrorHint: `Action requirements: ${ALL_ACTIONS.map((action) => ACTION_REQUIREMENTS[action]).join('; ')}. A batch is {"type":"batch","actions":[...]} with at most ${settings.maxBatchActions} actions and no screenshot, zoom, ui_snapshot or batch inside.`,
		category: 'custom',
		permissions: [],
		readOnly: (input: ActionInput) => isReadOnlyInput(input),
		destructive: (input: ActionInput) => isDestructiveInput(input),
		capturesScreen,
		concurrencySafe: false,
		presentCall: (input) => ({
			kind: 'generic',
			label: label(input),
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
					case 'ui_snapshot':
						return await uiSnapshot(input)
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
	return Object.assign(tool, { describeUiRef })
}
