import {
	SCOPE_ATTRIBUTE,
	type ToolCallView,
	type ToolManager,
	type ToolPresenter,
	createToolPresenter,
} from '@namzu/sdk'
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
				(view.outcome === undefined || view.outcome === 'cancelled')
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
	return {
		presentCall: (toolName, input) =>
			admit(toolName, 'presentCall', () => presenter.presentCall(toolName, input)) ?? {
				kind: 'generic',
				// Never stringify unreadable input as a replacement for a broken label.
				label: toolName,
			},
		presentResult: (toolName, input, result) =>
			admit(toolName, 'presentResult', () => presenter.presentResult(toolName, input, result)) ?? {
				kind: 'terminal',
				output: (result.success ? result.output : (result.error ?? result.output)) ?? '',
			},
	}
}
