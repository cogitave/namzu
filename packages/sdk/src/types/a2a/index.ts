export type A2ATaskState =
	| 'pending'
	| 'running'
	| 'completed'
	| 'failed'
	| 'canceled'
	| 'rejected'
	| 'input-required'

export type A2APartKind = 'text' | 'file' | 'data'

export type A2AMessageRole = 'user' | 'agent'

export type A2ATransport = 'jsonrpc' | 'rest' | 'grpc'

export type A2AMethod =
	| 'message/send'
	| 'message/sendStreaming'
	| 'tasks/get'
	| 'tasks/list'
	| 'tasks/cancel'
	| 'tasks/subscribe'
	| 'tasks/pushNotification/set'
	| 'tasks/pushNotification/get'
	| 'tasks/pushNotification/list'
	| 'tasks/pushNotification/delete'
	| 'agent/card'

export type A2AErrorCode =
	| 'TaskNotFound'
	| 'TaskNotCancelable'
	| 'ContentTypeNotSupported'
	| 'UnsupportedOperation'
	| 'PushNotificationNotSupported'
	| 'InvalidRequest'
	| 'InternalError'
	| 'Unauthorized'

export interface TextPart {
	readonly kind: 'text'
	readonly text: string
	readonly metadata?: Record<string, unknown>
}

export interface FilePart {
	readonly kind: 'file'
	readonly file: {
		readonly uri: string
		readonly mimeType: string
		readonly name?: string

		readonly bytes?: string
	}
	readonly metadata?: Record<string, unknown>
}

export interface DataPart {
	readonly kind: 'data'
	readonly data: Record<string, unknown>
	readonly mimeType?: string
	readonly metadata?: Record<string, unknown>
}

export type A2APart = TextPart | FilePart | DataPart

export interface A2AMessage {
	readonly role: A2AMessageRole
	readonly parts: readonly A2APart[]
	readonly metadata?: Record<string, unknown>
}

export interface A2ATaskStatus {
	readonly state: A2ATaskState
	readonly message?: A2AMessage
	readonly timestamp?: string
}

export interface A2AArtifact {
	readonly artifactId: string
	readonly name?: string
	readonly description?: string
	readonly parts: readonly A2APart[]
	readonly metadata?: Record<string, unknown>
}

export interface A2ATask {
	readonly id: string
	readonly contextId?: string
	readonly status: A2ATaskStatus
	readonly history?: readonly A2AMessage[]
	readonly artifacts?: readonly A2AArtifact[]
	readonly metadata?: Record<string, unknown>
}

export interface A2AAgentProvider {
	readonly organization: string
	readonly url?: string
}

export interface A2AAgentCapabilities {
	readonly streaming?: boolean
	readonly pushNotifications?: boolean
	readonly extendedAgentCard?: boolean
}

export interface A2AAgentSkill {
	readonly id: string
	readonly name: string
	readonly description: string
	readonly tags?: readonly string[]
	readonly examples?: readonly string[]
	readonly inputModes?: readonly string[]
	readonly outputModes?: readonly string[]
}

export interface A2AAgentInterface {
	readonly url: string
	readonly transport: A2ATransport
}

export interface A2ASecurityScheme {
	readonly type: 'http' | 'apiKey' | 'oauth2' | 'openIdConnect'
	readonly scheme?: string
	readonly bearerFormat?: string
	readonly in?: 'header' | 'query' | 'cookie'
	readonly name?: string
}

export interface A2ASecurityRequirement {
	readonly [schemeName: string]: readonly string[]
}

export interface A2AAgentCard {
	readonly name: string
	readonly description: string
	readonly version: string
	readonly protocolVersion?: string
	readonly provider?: A2AAgentProvider
	readonly documentationUrl?: string
	readonly capabilities: A2AAgentCapabilities
	readonly defaultInputModes: readonly string[]
	readonly defaultOutputModes: readonly string[]
	readonly skills: readonly A2AAgentSkill[]
	readonly securitySchemes?: Record<string, A2ASecurityScheme>
	readonly securityRequirements?: readonly A2ASecurityRequirement[]
	readonly iconUrl?: string
	readonly supportedInterfaces: readonly A2AAgentInterface[]
}

export interface TaskStatusUpdateEvent {
	readonly taskId: string
	readonly contextId?: string
	readonly status: A2ATaskStatus
	readonly final: boolean
	readonly metadata?: Record<string, unknown>
}

export interface TaskArtifactUpdateEvent {
	readonly taskId: string
	readonly contextId?: string
	readonly artifact: A2AArtifact
	readonly metadata?: Record<string, unknown>
}

export type A2AStreamEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent

export interface A2APushNotificationConfig {
	readonly id?: string
	readonly url: string
	readonly token?: string
	readonly authentication?: {
		readonly schemes: readonly string[]
		readonly credentials?: string
	}
	readonly events?: readonly A2ATaskState[]
}

export interface A2AMessageSendParams {
	readonly message: A2AMessage

	readonly id?: string

	readonly contextId?: string
	readonly metadata?: Record<string, unknown>
}

export interface A2ATaskQueryParams {
	readonly id: string
	readonly includeHistory?: boolean
}

export interface A2ATaskListParams {
	readonly contextId?: string
	readonly state?: A2ATaskState
	readonly limit?: number
	readonly cursor?: string
}

export interface A2ATaskCancelParams {
	readonly id: string
}

export interface A2AJsonRpcRequest {
	readonly jsonrpc: '2.0'
	readonly id: string | number
	readonly method: A2AMethod
	readonly params?: unknown
}

export interface A2AJsonRpcResponse<T = unknown> {
	readonly jsonrpc: '2.0'
	readonly id: string | number
	readonly result?: T
	readonly error?: A2AJsonRpcError
}

export interface A2AJsonRpcError {
	readonly code: number
	readonly message: string
	readonly data?: unknown
}

export class A2AProtocolError extends Error {
	constructor(
		public readonly code: A2AErrorCode,
		message: string,
		public readonly httpStatus: number = 400,
	) {
		super(message)
		this.name = 'A2AProtocolError'
	}
}

export interface A2AServerConfig {
	readonly baseUrl: string
	readonly transport: A2ATransport
	readonly providerOrganization?: string
	readonly providerUrl?: string
}
