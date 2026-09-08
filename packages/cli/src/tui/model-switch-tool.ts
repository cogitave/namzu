import { type ToolContext, type ToolDefinition, defineTool, mcpJsonSchemaToZod } from '@namzu/sdk'

import type { ModelSwitchOutcome, ModelSwitchRequest } from './model-switch.js'

export type { ModelSwitchOutcome } from './model-switch.js'

export type RequestModelSwitch = (
	request: ModelSwitchRequest,
	context: ToolContext,
) => Promise<ModelSwitchOutcome>

/** Mounted only when the main interactive session supplies this capability. */
export function buildSwitchModelTool(requestSwitch: RequestModelSwitch): ToolDefinition {
	return defineTool({
		name: 'switch_model',
		description:
			'Change the active conversation model only when the user explicitly requests a model change. Supply an exact model ID and optionally a provider ID; never infer a provider from a model name. A verified request is queued for this session only and applies after the current turn settles. After acceptance, briefly report that the change is pending and end your turn so the host can apply it. Do not claim the model has already changed or use this tool to change a delegated agent.',
		inputSchema: mcpJsonSchemaToZod({
			type: 'object',
			properties: {
				model: {
					type: 'string',
					minLength: 1,
					maxLength: 256,
					description: 'Exact model ID from a detected provider catalogue.',
				},
				provider: {
					type: 'string',
					minLength: 1,
					maxLength: 128,
					description:
						'Optional exact provider ID. Omit to prefer the current provider when it lists this model.',
				},
			},
			required: ['model'],
			additionalProperties: false,
		}),
		category: 'custom',
		permissions: [],
		// This only requests a host-controlled session setting change after an
		// explicit user request. It performs no workspace or external write.
		readOnly: true,
		destructive: false,
		concurrencySafe: false,
		timeoutMs: 10_000,
		async execute(input, context) {
			context.abortSignal?.throwIfAborted()
			let outcome: ModelSwitchOutcome
			try {
				outcome = await requestSwitch(input as ModelSwitchRequest, context)
			} catch {
				context.abortSignal?.throwIfAborted()
				return {
					success: false,
					output: '',
					error: 'Could not queue the model change. The active model has not changed.',
				}
			}
			context.abortSignal?.throwIfAborted()
			if (outcome.kind === 'rejected') {
				const choices = outcome.choices
					?.map((choice) => `${choice.provider}: ${choice.model}`)
					.join('; ')
				return {
					success: false,
					output: '',
					error: `${outcome.reason}${choices ? ` Available choices: ${choices}.` : ''}`,
					...(outcome.choices ? { data: { choices: outcome.choices } } : {}),
				}
			}
			return {
				success: true,
				output: `Model change queued: ${outcome.selection.id}/${outcome.selection.model}. It is pending until this turn finishes; end your turn to let the host apply it. This change affects only this session.`,
				data: { status: 'pending', provider: outcome.selection.id, model: outcome.selection.model },
			}
		},
	})
}
