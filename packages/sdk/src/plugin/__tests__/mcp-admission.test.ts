import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MCPToolDefinition } from '../../types/connector/index.js'

/**
 * A plugin's MCP server decided what entered the agent's tool registry.
 *
 * `MCPToolDiscovery` has held the admission boundary — a per-server
 * allow/deny policy, and detection for a server whose tool set changes
 * between discoveries — since it was written, and nothing outside its own
 * tests ever constructed one. `PluginLifecycleManager.attachMCPServer`, the
 * only code in the tree that connects a real MCP server, called
 * `client.listTools()` and registered whatever came back.
 *
 * So least privilege was inverted at the one place it mattered: the remote
 * side chose. Tools land as `deferred` and a run's `allowedTools` filters the
 * model-visible catalogue, so this was not "arbitrary tools reach the model
 * immediately" — but the check written for exactly this was not on the path.
 */

let advertised: MCPToolDefinition[] = []
let advertisedPrompts: { name: string; description?: string }[] = []
let clientCount = 0

vi.mock('../../connector/mcp/client.js', () => ({
	MCPClient: class {
		readonly id: string
		private serverName: string
		constructor(config: { serverName: string }) {
			this.id = `client_${clientCount++}`
			this.serverName = config.serverName
		}
		async connect(): Promise<void> {}
		async disconnect(): Promise<void> {}
		isConnected(): boolean {
			return true
		}
		getState() {
			return { serverName: this.serverName }
		}
		async listTools(): Promise<MCPToolDefinition[]> {
			return advertised
		}
		async listPrompts() {
			return advertisedPrompts
		}
	},
}))

function tool(name: string): MCPToolDefinition {
	return { name, description: name, inputSchema: { type: 'object', properties: {} } }
}

const log = {
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	child: () => log,
} as never

let root: string

interface Harness {
	readonly registered: string[]
	readonly manager: import('../lifecycle.js').PluginLifecycleManager
	enable(name: string): Promise<import('../../types/ids/index.js').PluginId>
}

async function harness(config: Record<string, unknown> = {}): Promise<Harness> {
	const { PluginLifecycleManager } = await import('../lifecycle.js')
	const { PluginRegistry } = await import('../../registry/plugin/index.js')

	const registered: string[] = []
	const toolRegistry = {
		register: (definition: { name: string }) => registered.push(definition.name),
		unregister: () => undefined,
		get: () => undefined,
	} as never

	const manager = new PluginLifecycleManager({
		pluginRegistry: new PluginRegistry(),
		toolRegistry,
		log,
		...config,
	} as never)

	return {
		registered,
		manager,
		enable: async (name: string) => {
			const dir = join(root, name)
			await mkdir(dir, { recursive: true })
			await writeFile(
				join(dir, 'plugin.json'),
				JSON.stringify({
					name,
					version: '1.0.0',
					description: 'MCP server plugin fixture',
					mcpServers: [{ name: 'files', command: 'node', args: ['server.js'] }],
				}),
				'utf-8',
			)
			const plugin = await manager.install(dir, 'project')
			await manager.enable(plugin.id)
			return plugin.id
		},
	}
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'namzu-mcp-admit-'))
	clientCount = 0
	advertised = [tool('read_file'), tool('write_file'), tool('delete_everything')]
	advertisedPrompts = [{ name: 'safe_prompt' }, { name: 'sneaky_prompt' }]
})

afterEach(async () => {
	await rm(root, { recursive: true, force: true })
	vi.clearAllMocks()
})

describe('what a plugin server advertises is not what the registry gets', () => {
	it('admits only the tools an allowlist names', async () => {
		const h = await harness({ mcpToolPolicies: { files: { allow: ['read_file', 'write_file'] } } })

		await h.enable('srv')

		expect(h.registered.some((n) => n.endsWith('read_file'))).toBe(true)
		expect(h.registered.some((n) => n.endsWith('write_file'))).toBe(true)
		// The one the server offered and the host never agreed to.
		expect(h.registered.some((n) => n.endsWith('delete_everything'))).toBe(false)
	})

	it('refuses a denied tool through the wildcard policy', async () => {
		const h = await harness({ mcpToolPolicies: { '*': { deny: ['delete_everything'] } } })

		await h.enable('srv')

		// Counted over TOOLS specifically: prompts register through the same
		// path and would otherwise make this assertion about both.
		expect(h.registered.filter((n) => n.includes('mcp__files__'))).toHaveLength(2)
		expect(h.registered.some((n) => n.endsWith('delete_everything'))).toBe(false)
	})

	it('still admits everything when no policy is configured', async () => {
		// Adding a boundary must not turn every existing host's working plugin
		// into a broken one.
		const h = await harness()

		await h.enable('srv')

		expect(h.registered.filter((n) => n.includes('mcp__files__'))).toHaveLength(3)
	})

	it('namespaces what it admits, exactly as before', async () => {
		const h = await harness({ mcpToolPolicies: { files: { allow: ['read_file'] } } })

		await h.enable('srv')

		expect(h.registered[0]).toContain('mcp__files__read_file')
	})
})

describe('a server that changes its tools between connections is reported', () => {
	it('says nothing the first time, having nothing to compare against', async () => {
		const onMCPToolDrift = vi.fn()
		const h = await harness({ onMCPToolDrift })

		await h.enable('srv')

		expect(onMCPToolDrift).not.toHaveBeenCalled()
	})

	it('reports a tool the server grew after it was first approved', async () => {
		const onMCPToolDrift = vi.fn()
		const h = await harness({ onMCPToolDrift })
		const first = await h.enable('srv-a')

		// The rug pull: advertise something benign while a host is deciding,
		// swap it afterwards. A NEW client connects to the SAME server, which
		// is why the remembered set is keyed by server name — keyed by client
		// id, as it was, every connection was its own first and this could
		// never fire.
		await h.manager.disable(first)
		advertised = [...advertised, tool('exfiltrate')]
		await h.enable('srv-b')

		expect(onMCPToolDrift).toHaveBeenCalledTimes(1)
		expect(onMCPToolDrift.mock.calls[0]?.[0]).toMatchObject({
			serverName: 'files',
			drift: { added: ['exfiltrate'] },
		})
	})

	it('reports a tool whose shape changed under the same name', async () => {
		const onMCPToolDrift = vi.fn()
		const h = await harness({ onMCPToolDrift })
		const first = await h.enable('srv-a')

		await h.manager.disable(first)
		// Same name, different input shape — the version a name-only check
		// misses entirely.
		advertised = [
			{
				name: 'read_file',
				description: 'read a file',
				inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
			},
			tool('write_file'),
			tool('delete_everything'),
		]
		await h.enable('srv-b')

		expect(onMCPToolDrift).toHaveBeenCalledTimes(1)
		expect(onMCPToolDrift.mock.calls[0]?.[0]).toMatchObject({ drift: { changed: ['read_file'] } })
	})

	it('says nothing when the server offers exactly what it offered before', async () => {
		const onMCPToolDrift = vi.fn()
		const h = await harness({ onMCPToolDrift })
		const first = await h.enable('srv-a')

		await h.manager.disable(first)
		await h.enable('srv-b')

		expect(onMCPToolDrift).not.toHaveBeenCalled()
	})

	it('compares what was ADMITTED, not what was advertised', async () => {
		const onMCPToolDrift = vi.fn()
		const h = await harness({
			mcpToolPolicies: { files: { allow: ['read_file'] } },
			onMCPToolDrift,
		})
		const first = await h.enable('srv-a')

		await h.manager.disable(first)
		// A tool the policy refuses either way. Reporting drift for it would
		// train a host to ignore the warning that matters.
		advertised = [...advertised, tool('another_denied_one')]
		await h.enable('srv-b')

		expect(onMCPToolDrift).not.toHaveBeenCalled()
	})
})

describe('a prompt is admitted on the same terms as a tool', () => {
	it('registers the prompts a server publishes', async () => {
		const h = await harness()

		await h.enable('srv')

		expect(h.registered.some((n) => n.includes('mcp_prompt_files_safe_prompt'))).toBe(true)
	})

	it('refuses a prompt the policy does not allow', async () => {
		const h = await harness({
			mcpToolPolicies: { files: { allow: ['read_file', 'safe_prompt'] } },
		})

		await h.enable('srv')

		// A server publishing a prompt is the same trust question as one
		// publishing a tool: the remote side must not decide what enters the
		// registry. Two copies of an allow/deny check are two chances for one
		// of them to drift permissive, which is why both go through one.
		expect(h.registered.some((n) => n.includes('safe_prompt'))).toBe(true)
		expect(h.registered.some((n) => n.includes('sneaky_prompt'))).toBe(false)
	})

	it('names a prompt apart from a tool of the same name', async () => {
		advertisedPrompts = [{ name: 'read_file' }]
		const h = await harness()

		await h.enable('srv')

		// Both exist. Collapsing them would let whichever registered second
		// silently replace the first.
		expect(h.registered.some((n) => n.endsWith('mcp__files__read_file'))).toBe(true)
		expect(h.registered.some((n) => n.endsWith('mcp_prompt_files_read_file'))).toBe(true)
	})
})
