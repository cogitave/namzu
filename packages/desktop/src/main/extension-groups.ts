import { CONTEXT_REQUEST } from '../shared/context-protocol.js'
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
	limits: ['namzu/limits/refresh'],
	projectCommit: ['namzu/project/commit-preview', 'namzu/project/commit'],
	projectPr: ['namzu/project/pr'],
	mcpServers: ['namzu/mcp/servers', 'namzu/mcp/approve'],
	userMcpServers: [
		'namzu/mcp/user-servers',
		'namzu/mcp/save-user-server',
		'namzu/mcp/remove-user-server',
	],
	skillsList: ['namzu/skills/list'],
	skillsCatalog: ['namzu/skills/catalog', 'namzu/skills/files', 'namzu/skills/read_file'],
	/** The Customize page adds, makes and removes skills: stage a file, install it, create, remove. */
	skillsManage: [
		'namzu/skills/stage',
		'namzu/skills/install',
		'namzu/skills/create',
		'namzu/skills/remove',
	],
	/** The Customize page adds marketplaces and installs, updates and removes plugins; `namzu/ops/cancel` stops a long step. */
	pluginsManage: [
		'namzu/marketplaces/preview',
		'namzu/marketplaces/add',
		'namzu/marketplaces/list',
		'namzu/marketplaces/remove',
		'namzu/marketplaces/update',
		'namzu/marketplaces/available',
		'namzu/plugins/plan',
		'namzu/plugins/stage',
		'namzu/plugins/install',
		'namzu/plugins/enable',
		'namzu/plugins/update_check',
		'namzu/plugins/update',
		'namzu/plugins/uninstall',
		'namzu/ops/cancel',
	],
	browserStatus: ['namzu/browser/status'],
	hooksView: ['namzu/hooks/list'],
	standingInstructions: ['namzu/instructions/get', 'namzu/instructions/set'],
	savedMemory: [
		'namzu/memory/list',
		'namzu/memory/read',
		'namzu/memory/update',
		'namzu/memory/delete',
	],
	contextPanel: [CONTEXT_REQUEST],
	conversationSearch: ['namzu/conversations/search'],
	projectUntrust: ['namzu/project/untrust'],
	projectChanges: ['namzu/project/changes', 'namzu/project/diff'],
	turnRetry: ['namzu/sessions/retry-status', 'namzu/sessions/retry'],
	abandonPaused: ['namzu/sessions/abandon-paused'],
	turnUndo: ['namzu/turns/undo-status', 'namzu/turns/undo-preview', 'namzu/turns/undo'],
	liveInput: ['namzu/conversations/input/status', 'namzu/conversations/input'],
	livePermissionMode: ['namzu/session/set-permission-mode'],
	questionAnswer: ['namzu/session/answer-question'],
	browserRevoke: ['namzu/session/revoke-browser'],
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
	extensions: [
		'namzu/extensions/list',
		'namzu/extensions/add',
		'namzu/extensions/license',
		'namzu/extensions/notice',
		'namzu/extensions/acknowledge',
		'namzu/extensions/enable',
		'namzu/extensions/disable',
		'namzu/extensions/unlock',
		'namzu/extensions/remove',
		'namzu/extensions/grant',
		'namzu/extensions/revoke',
		'namzu/extensions/query',
		'namzu/extensions/settings/get',
		'namzu/extensions/settings/set',
		'namzu/extensions/audit',
		'namzu/extensions/background/get',
		'namzu/extensions/background/set',
		'namzu/extensions/ui',
		'namzu/extensions/action',
		'namzu/extensions/runner',
	],
	palComputerControl: [
		'namzu/pals/computer/take_over',
		'namzu/pals/computer/return_control',
		'namzu/pals/computer/input',
	],
	/** The engine takes the Browser pane's events: the agent's browser can run in a tab of the pane. */
	agentBrowserPane: ['namzu/browser/pane/event', 'namzu/browser/pane/state'],
} as const satisfies Record<string, readonly string[]>

export type OptionalExtensionGroup = keyof typeof OPTIONAL_EXTENSION_GROUPS
