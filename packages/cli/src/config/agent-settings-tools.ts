/**
 * `get_settings` and `set_setting`: the agent reads the safe settings and, with the person's yes,
 * changes one. What is allowed, and the checks, live in `agent-settings.ts`.
 *
 * Both tools are offered deferred (one name line in the listing). `set_setting` always puts its
 * change to a person on a card (`requiresApproval`): a remembered "allow for this conversation",
 * auto mode and bypass mode never answer it, and a conversation nobody watches refuses it. A value
 * that is refused anyway (not on the list, not a value the setting takes, decided by an
 * administrator or the environment) is refused before any card is shown.
 */

import { type ToolDefinition, defineTool, mcpJsonSchemaToZod } from '@namzu/sdk'
import {
	AGENT_SETTINGS,
	AGENT_TEXT_MAX,
	type AgentSettingsContext,
	applyAgentChange,
	describeAgentChange,
	planAgentChange,
	readAgentSettings,
} from './agent-settings.js'

export const GET_SETTINGS_TOOL = 'get_settings'
export const SET_SETTING_TOOL = 'set_setting'

const GET_DESCRIPTION =
	'Read the settings you may change for the person, with their current values, and a few facts you may only read (the permission mode, whether bypass and auto mode are allowed, whether computer use is on, the default model). Call it before set_setting, and when the person asks how something is set. Anything about permissions, the sandbox, the browser, sites, tool servers, hooks, plugins, models, keys or updates is not listed: only the person changes those, in Settings.'

const SET_DESCRIPTION = `Change one setting for the person, such as turning on a notification sound or setting how long before inactive conversations are archived. The person is asked first on a card showing the old and new value, so say in your own words why you are changing it. Use the setting names get_settings lists. A value an administrator or the environment decides is refused with who decides it, and any setting get_settings does not list is refused: only the person changes those, in Settings. Text values are at most ${AGENT_TEXT_MAX} characters.`

/** The tools, for a host that can ask a person. */
export function createAgentSettingsTools(ctx: AgentSettingsContext): ToolDefinition[] {
	const get = defineTool({
		name: GET_SETTINGS_TOOL,
		description: GET_DESCRIPTION,
		inputSchema: mcpJsonSchemaToZod({
			type: 'object',
			properties: {},
			additionalProperties: false,
		}),
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		async execute() {
			try {
				return { success: true, output: JSON.stringify(readAgentSettings(ctx)) }
			} catch (cause) {
				return {
					success: false,
					output: '',
					error: cause instanceof Error ? cause.message : String(cause),
				}
			}
		},
	})

	const set = defineTool({
		name: SET_SETTING_TOOL,
		description: SET_DESCRIPTION,
		inputSchema: mcpJsonSchemaToZod({
			type: 'object',
			properties: {
				setting: {
					type: 'string',
					description: `The setting, as get_settings names it: ${AGENT_SETTINGS.map((row) => row.id).join(', ')}.`,
				},
				value: {
					anyOf: [{ type: 'boolean' }, { type: 'string', maxLength: AGENT_TEXT_MAX }],
					description:
						'The new value: true or false for a switch, one of the values get_settings lists for a choice, a line of text for a text setting.',
				},
			},
			required: ['setting', 'value'],
			additionalProperties: false,
		}),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: false,
		// Every call, whatever the mode or any earlier yes: this is the person's own settings.
		requiresApproval: true,
		async refuseBeforeReview(input) {
			const planned = planAgentChange(ctx, input as { setting: unknown; value: unknown })
			return planned.ok ? undefined : { error: planned.reason }
		},
		presentCall(input) {
			const said = describeAgentChange(ctx, input)
			if (!said) return undefined
			return { kind: 'generic', label: `Change ${said.setting}: ${said.from} to ${said.to}` }
		},
		async execute(input) {
			const planned = planAgentChange(ctx, input as { setting: unknown; value: unknown })
			if (!planned.ok) return { success: false, output: '', error: planned.reason }
			try {
				return { success: true, output: await applyAgentChange(ctx, planned.change) }
			} catch (cause) {
				return {
					success: false,
					output: '',
					error: cause instanceof Error ? cause.message : String(cause),
				}
			}
		},
	})
	return [get, set]
}
