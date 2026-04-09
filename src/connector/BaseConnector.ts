import type { z } from 'zod'
import type {
	AuthConfig,
	ConnectionType,
	ConnectorDefinition,
	ConnectorExecuteResult,
	ConnectorLifecycle,
	ConnectorMethod,
} from '../types/connector/index.js'
import { type Logger, getRootLogger } from '../utils/logger.js'

export abstract class BaseConnector<TConfig = unknown> implements ConnectorLifecycle<TConfig> {
	abstract readonly id: string
	abstract readonly name: string
	abstract readonly description: string
	abstract readonly connectionType: ConnectionType
	abstract readonly configSchema: z.ZodType<TConfig, z.ZodTypeDef, unknown>
	abstract readonly methods: ConnectorMethod[]

	protected log: Logger
	protected config: TConfig | null = null
	protected auth: AuthConfig | undefined

	constructor() {
		this.log = getRootLogger().child({ component: this.constructor.name })
	}

	abstract connect(config: TConfig, auth?: AuthConfig): Promise<void>
	abstract disconnect(): Promise<void>
	abstract healthCheck(): Promise<boolean>
	abstract execute(method: string, input: unknown): Promise<ConnectorExecuteResult>

	toDefinition(): ConnectorDefinition<TConfig> {
		return {
			id: this.id,
			name: this.name,
			description: this.description,
			connectionType: this.connectionType,
			configSchema: this.configSchema,
			methods: this.methods,
		}
	}

	protected findMethod(methodName: string): ConnectorMethod | undefined {
		return this.methods.find((m) => m.name === methodName)
	}

	protected requireMethod(methodName: string): ConnectorMethod {
		const method = this.findMethod(methodName)
		if (!method) {
			throw new Error(
				`Method "${methodName}" not found on connector "${this.id}". ` +
					`Available: ${this.methods.map((m) => m.name).join(', ')}`,
			)
		}
		return method
	}

	protected validateInput(method: ConnectorMethod, input: unknown): unknown {
		const result = method.inputSchema.safeParse(input)
		if (!result.success) {
			const errors = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
			throw new Error(`Invalid input for method "${method.name}": ${errors}`)
		}
		return result.data
	}

	protected measureExecution<TResult>(
		fn: () => Promise<TResult>,
	): Promise<{ result: TResult; durationMs: number }> {
		const start = performance.now()
		return fn().then((result) => ({
			result,
			durationMs: Math.round(performance.now() - start),
		}))
	}
}
