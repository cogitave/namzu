export { type Agent, listAgents, type ListAgentsOptions } from './agents.js'
export { ClawtoolAuthError, readToken, tryReadToken } from './auth.js'
export { ClawtoolBinaryError, findBinary, type FindBinaryOptions } from './binary.js'
export { ensureDaemon, ClawtoolDaemonError, type EnsureDaemonOptions } from './daemon.js'
export { type DispatchEvent, sendMessage, type SendMessageOptions } from './dispatch.js'
export {
	ClawtoolMcpClient,
	MCP_PROTOCOL_VERSION,
	McpProtocolError,
	type McpClientOptions,
} from './mcp.js'
export {
	clawtoolConfigDir,
	daemonStatePath,
	listenerTokenPath,
} from './paths.js'
export {
	createClawtoolPlugin,
	type ClawtoolPlugin,
	type ClawtoolProxyTool,
	type CreateClawtoolPluginOptions,
} from './plugin.js'
export {
	type Preferences,
	PreferencesError,
	PREFERENCES_FILE_VERSION,
	preferencesPath,
	readPreferences,
	writePreferences,
} from './preferences.js'
export { readDaemonState } from './state.js'
export type {
	DaemonEndpoint,
	DaemonState,
	McpCallResult,
	McpTextContent,
	McpToolDescriptor,
} from './types.js'
