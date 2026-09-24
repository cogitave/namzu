export { BaseRegistry } from './BaseRegistry.js'
export { RegistryCollisionError } from './collision.js'
export type { RegistryCollisionPolicy } from './collision.js'
export { ManagedRegistry } from './ManagedRegistry.js'
export type { ManagedRegistryConfig } from './ManagedRegistry.js'

export { ToolNameCollisionError, TOOL_NAME_PATTERN, assertToolName } from './tool/execute.js'

export { ConnectorRegistry } from './connector/definitions.js'
export { ScopedConnectorRegistry } from './connector/scoped.js'

export { AgentRegistry } from './agent/definitions.js'
export { PluginRegistry } from './plugin/index.js'

// Commands a HOST offers its operator — never model-visible, and not tools.
// The whole vocabulary used to be a literal array in one host's TUI module.
export { HostCommandNameCollisionError, HostCommandRegistry } from './command/index.js'
export { kernelHostCommands } from './command/kernel-commands.js'
export type { KernelCommandOptions } from './command/kernel-commands.js'
