export const GENAI = {
	OPERATION_NAME: 'gen_ai.operation.name',
	SYSTEM: 'gen_ai.system',

	REQUEST_MODEL: 'gen_ai.request.model',
	REQUEST_TEMPERATURE: 'gen_ai.request.temperature',
	REQUEST_MAX_TOKENS: 'gen_ai.request.max_tokens',

	RESPONSE_MODEL: 'gen_ai.response.model',
	RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons',
	RESPONSE_ID: 'gen_ai.response.id',

	USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
	USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',

	/**
	 * Which kind of token a usage measurement counts. The convention keys
	 * one metric by this rather than minting a metric name per kind, so a
	 * dashboard that sums the metric gets the whole picture instead of one
	 * slice of it.
	 */
	TOKEN_TYPE: 'gen_ai.token.type',

	TOOL_NAME: 'gen_ai.tool.name',
	TOOL_TYPE: 'gen_ai.tool.type',

	/**
	 * The id of the tool call this span is about.
	 *
	 * Spelled `call.id`, matching the registry and matching the two
	 * neighbours above — this read `gen_ai.tool.call_id`, one underscore
	 * where the convention has a dot, so a consumer grouping by the
	 * conventional name found nothing under it. Nothing errored, because a
	 * span attribute is a free-form key and a wrong one is simply a key
	 * nobody asked for.
	 *
	 * Pinned by `telemetry/__tests__/tool-call-id-attribute.test.ts`, which
	 * also drives the emitter: the spelling was only half the defect, and
	 * the constant had no writer at all.
	 */
	TOOL_CALL_ID: 'gen_ai.tool.call.id',

	AGENT_NAME: 'gen_ai.agent.name',
	AGENT_ID: 'gen_ai.agent.id',
} as const

export const NAMZU = {
	RUN_ID: 'namzu.run.id',
	RUN_STATUS: 'namzu.run.status',
	ITERATION: 'namzu.iteration',
	TOOL_SUCCESS: 'namzu.tool.success',
	TOOL_ERROR: 'namzu.tool.error',
	COST_TOTAL: 'namzu.cost.total',
	CACHE_READ_TOKENS: 'namzu.cache.read_tokens',
	CACHE_WRITE_TOKENS: 'namzu.cache.write_tokens',
	CACHE_DISCOUNT: 'namzu.cache.discount',

	// Correlation attributes for the run's own logger — see
	// RunContextFactory.buildLogger (runtime/query/context.ts). RUN_ID above
	// already covered the run itself; these are the layers above it
	// (Tenant -> Project -> Thread -> Session -> Run, Convention #17) that
	// used to reach the run's logger as four bare, un-namespaced keys.
	SESSION_ID: 'namzu.session.id',
	THREAD_ID: 'namzu.thread.id',
	PROJECT_ID: 'namzu.project.id',
	TENANT_ID: 'namzu.tenant.id',
	// Set only when a run was started by another run (the sub-agent gateway
	// path) — see query()'s params.parentRunId in runtime/query/index.ts.
	// Previously reached the RunContext's own fields but never the logger.
	RUN_PARENT_ID: 'namzu.run.parent_id',

	// AbstractAgent's per-instance identity (agents/AbstractAgent.ts). The id
	// half reuses GENAI.AGENT_ID — an agent's id is the same concept whether
	// it is read off a span or a log record, and GENAI.AGENT_ID already
	// exists and is already bound at the run's own correlated logger and
	// root span. TYPE has no GENAI analogue, so it is new.
	AGENT_TYPE: 'namzu.agent.type',

	// ManagedRegistry's per-subclass distinction (registry/ManagedRegistry.ts).
	// scope.name is fixed to 'registry' for every ManagedRegistry subclass —
	// they all log through this one file — so the per-instance name that
	// `component: config.componentName` used to carry moves here instead.
	// `ManagedRegistryConfig.componentName`'s FIELD NAME is unchanged.
	REGISTRY_NAME: 'namzu.registry.name',

	// InMemoryCredentialVault (vault/InMemoryCredentialVault.ts) — closes a
	// PRE-EXISTING violation of "no attribute string literal at a call
	// site": both keys already existed as raw string literals there before
	// this change. Values are unchanged.
	CREDENTIAL_ID: 'namzu.credential.id',
	CREDENTIAL_LABEL: 'namzu.credential.label',

	// MCPClient (connector/mcp/client.ts). SERVER_ID is the OPERATOR's own
	// configured identifier for the connector instance being dialed;
	// SERVER_NAME is the REMOTE server's own self-reported name from its
	// initialize response — kept separate on purpose, since the remote's
	// self-report is attacker-influenced data (see
	// connector/mcp/__tests__/a-server-cannot-forge-a-second-log-line.test.ts).
	// SERVER_NAME closes the same kind of pre-existing literal violation as
	// the two CREDENTIAL_* keys above.
	SERVER_ID: 'namzu.connector.server.id',
	SERVER_NAME: 'namzu.connector.server.name',
} as const

/**
 * The boot narrative's closed event-name vocabulary — every `eventName` the
 * SDK itself emits between process start and `namzu.boot.ready`. A call
 * site spells `BOOT_EVENT_NAMES.X`, not the literal string, so a typo
 * becomes a missing property at compile time rather than a name that
 * silently never matches a host's filter.
 *
 * `BootEventName` is DERIVED from this record rather than declared beside
 * it, so the two cannot drift — there is only one place a member is added.
 * `LogRecord.eventName` itself stays `string`, not this union: widening it
 * to a fixed union would make the field unusable for a future emitter
 * naming events from a different vocabulary.
 */
export const BOOT_EVENT_NAMES = {
	BOOT_START: 'namzu.boot.start',
	CONFIG_RESOLVED: 'namzu.config.resolved',
	SANDBOX_RESOLVED: 'namzu.sandbox.resolved',
	PROVIDER_RESOLVED: 'namzu.provider.resolved',
	CAPABILITY_DETECTED: 'namzu.capability.detected',
	CAPABILITY_BROKEN: 'namzu.capability.broken',
	TELEMETRY_STATUS: 'namzu.telemetry.status',
	MIGRATION_COMPLETED: 'namzu.migration.completed',
	DISCOVERY_COMPLETED: 'namzu.discovery.completed',
	BOOT_REFUSED: 'namzu.boot.refused',
	BOOT_READY: 'namzu.boot.ready',
} as const

export type BootEventName = (typeof BOOT_EVENT_NAMES)[keyof typeof BOOT_EVENT_NAMES]
