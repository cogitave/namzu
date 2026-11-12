import { TERMINAL_METHODS } from '../shared/terminal-protocol.js'
import { PAL_COMMUNICATION_METHODS } from './pal-communication.js'

/**
 * The methods the app probes for after `initialize`, in the groups it turns on together: a group is
 * on only when the host lists every method of it. One list, read by the connection and by the
 * desktop-contract test, which compares it with packages/cli/desktop-contract/inventory.json so that
 * a method the app starts relying on is recorded for the engine's guard.
 */
export const OPTIONAL_EXTENSION_GROUPS = {
	tasks: ['namzu/tasks/list'],
	palCommunication: PAL_COMMUNICATION_METHODS,
	conversationActions: [
		'namzu/conversations/rename',
		'namzu/conversations/fork',
		'namzu/conversations/markdown',
	],
	archivedConversations: ['namzu/conversations/archived', 'namzu/conversations/unarchive'],
	terminals: Object.values(TERMINAL_METHODS),
	providerSetup: [
		'namzu/providers/connections',
		'namzu/providers/save_key',
		'namzu/providers/remove_key',
		'namzu/providers/test',
		'namzu/providers/refresh',
	],
	projectGit: ['namzu/project/git'],
	projectPr: ['namzu/project/pr'],
	mcpServers: ['namzu/mcp/servers', 'namzu/mcp/approve'],
	conversationSearch: ['namzu/conversations/search'],
	projectUntrust: ['namzu/project/untrust'],
	projectChanges: ['namzu/project/changes', 'namzu/project/diff'],
	turnRetry: ['namzu/sessions/retry-status', 'namzu/sessions/retry'],
	abandonPaused: ['namzu/sessions/abandon-paused'],
	turnUndo: ['namzu/turns/undo-status', 'namzu/turns/undo-preview', 'namzu/turns/undo'],
	liveInput: ['namzu/conversations/input/status', 'namzu/conversations/input'],
	pals: [
		'namzu/pals/list',
		'namzu/pals/get',
		'namzu/pals/create',
		'namzu/pals/update',
		'namzu/pals/conversations/list',
		'namzu/pals/conversations/claim',
		'namzu/pals/computer/status',
		'namzu/pals/computer/start',
		'namzu/pals/computer/stop',
		'namzu/pals/computer/screen',
	],
	palInboxStart: ['namzu/pals/inbox/status', 'namzu/pals/inbox/start'],
	palComputerControl: [
		'namzu/pals/computer/take_over',
		'namzu/pals/computer/return_control',
		'namzu/pals/computer/input',
	],
} as const satisfies Record<string, readonly string[]>

export type OptionalExtensionGroup = keyof typeof OPTIONAL_EXTENSION_GROUPS
