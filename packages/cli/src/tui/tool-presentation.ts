import {
	SCOPE_ATTRIBUTE,
	SearchToolsTool,
	SkillTool,
	type ToolCallView,
	type ToolManager,
	type ToolPresenter,
	createToolPresenter,
} from '@namzu/sdk'
import {
	AGENT_LIST_CALL_LABEL,
	WAIT_CALL_LABEL,
	agentListLabel,
	waitResultLabel,
} from '../integrations/subagents/row-labels.js'
import { cliLogger } from '../logging.js'

const optionalText = (value: unknown): boolean => value === undefined || typeof value === 'string'

/** A presentation hook can see refused input before it satisfies the tool schema. */
export function admitToolView(value: unknown): ToolCallView | undefined {
	if (!value || typeof value !== 'object') return undefined
	const view = value as Record<string, unknown>
	switch (view.kind) {
		case 'generic':
			return typeof view.label === 'string' &&
				(view.presentation === undefined || view.presentation === 'activity') &&
				(view.activity === undefined || view.activity === 'exploration') &&
				(view.visibility === undefined || view.visibility === 'hidden') &&
				(view.outcome === undefined || view.outcome === 'cancelled') &&
				(view.declined === undefined ||
					(typeof view.declined === 'object' && view.declined !== null))
				? (value as ToolCallView)
				: undefined
		case 'diff':
			return typeof view.before === 'string' &&
				typeof view.after === 'string' &&
				optionalText(view.path) &&
				optionalText(view.label)
				? (value as ToolCallView)
				: undefined
		case 'terminal':
			return typeof view.output === 'string' && optionalText(view.command)
				? (value as ToolCallView)
				: undefined
		default:
			return undefined
	}
}

type OwnedView = {
	readonly call: (input: unknown) => ToolCallView
	readonly result: (input: unknown, output: string) => ToolCallView | undefined
}

/**
 * Tools the application mounts itself, per session: a presenter built from the
 * built-in tools alone has no definition for them, so a restored transcript
 * would draw their raw call and body. One function per tool, used by the live
 * presenter and the restored one alike; the tools' own hooks say the same.
 */
const OWNED_VIEWS: Readonly<Record<string, OwnedView>> = {
	agent_task_list: {
		call: () => ({ kind: 'generic', label: AGENT_LIST_CALL_LABEL, presentation: 'activity' }),
		result: (_input, output) => ({ kind: 'generic', label: agentListLabel(output) }),
	},
	wait_for_task: {
		call: () => ({ kind: 'generic', label: WAIT_CALL_LABEL, presentation: 'activity' }),
		result: (_input, output) => ({ kind: 'generic', label: waitResultLabel(output) }),
	},
	search_tools: {
		call: (input) => SearchToolsTool.presentCall?.(input as never) as ToolCallView,
		result: (input, output) =>
			SearchToolsTool.presentResult?.(input as never, { success: true, output }) as
				| ToolCallView
				| undefined,
	},
	skill: {
		call: (input) => SkillTool.presentCall?.(input as never) as ToolCallView,
		result: (input, output) =>
			SkillTool.presentResult?.(input as never, { success: true, output }) as
				| ToolCallView
				| undefined,
	},
}

/** Whether the application draws this tool's result as one line of its own. */
export function hasOwnedView(toolName: string): boolean {
	return Object.hasOwn(OWNED_VIEWS, toolName)
}

/** Rendering must not interrupt the runtime's refusal, retry or settlement. */
export function createCliToolPresenter(registry: Pick<ToolManager, 'get'>): ToolPresenter {
	const log = cliLogger().child({ [SCOPE_ATTRIBUTE]: 'cli/tool-presentation' })
	const presenter = createToolPresenter(registry, log)
	const admit = (toolName: string, hook: string, present: () => ToolCallView) => {
		try {
			const view = admitToolView(present())
			if (view) return view
		} catch {
			// A malformed view or fallback must not become a failed model turn.
		}
		log.warn('Tool presentation was invalid; using a plain view', {
			'namzu.tool.name': toolName,
			'namzu.tool.presenter_hook': hook,
		})
		return undefined
	}
	const ownedResult = (
		toolName: string,
		input: unknown,
		result: { success: boolean; output?: string },
	): ToolCallView | undefined => {
		const owned = OWNED_VIEWS[toolName]
		if (!owned || !result.success) return undefined
		try {
			return admitToolView(owned.result(input, result.output ?? ''))
		} catch {
			return undefined
		}
	}
	return {
		presentCall: (toolName, input) =>
			(OWNED_VIEWS[toolName]
				? admit(toolName, 'presentCall', () => (OWNED_VIEWS[toolName] as OwnedView).call(input))
				: undefined) ??
			admit(toolName, 'presentCall', () => presenter.presentCall(toolName, input)) ?? {
				kind: 'generic',
				// Never stringify unreadable input as a replacement for a broken label.
				label: toolName,
			},
		presentResult: (toolName, input, result) =>
			ownedResult(toolName, input, result) ??
			admit(toolName, 'presentResult', () => presenter.presentResult(toolName, input, result)) ?? {
				kind: 'terminal',
				output: (result.success ? result.output : (result.error ?? result.output)) ?? '',
			},
	}
}
