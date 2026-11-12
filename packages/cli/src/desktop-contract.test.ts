import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	ACPServer,
	ACP_CLIENT_NOTIFICATIONS,
	ACP_CLIENT_REQUESTS,
	ACP_METHODS,
	type AcpInitializeResult,
	DATA_EPOCH,
	HostCommandRegistry,
	type MCPJsonRpcMessage,
	type MCPTransport,
	ToolManager,
	VERSION,
	createToolPresenter,
} from '@namzu/sdk'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { removeTempDir } from './__fixtures__/temp-dir.js'
import { runCli } from './cli.js'
import { acpCommand, createCliAcpRuntime, desktopServerExtensions } from './commands/acp.js'
import { OUTCOME_NOTIFICATION } from './commands/desktop-outcome-feed.js'
import { USAGE_NOTIFICATION } from './commands/desktop-usage-feed.js'
import { readPalComputerBundle } from './computer/bundle.js'
import { COMPUTER_HELP } from './computer/run.js'
import { DESKTOP_CONTRACT } from './desktop-contract.js'
import { createPalInboxStarter } from './pals/inbox-start.js'
import { PERMISSION_MODE_NAMES } from './permissions/mode-names.js'
import { TERMINAL_METHODS, TERMINAL_NOTIFICATIONS } from './terminal/protocol.js'
import { CLI_VERSION } from './version.js'

/**
 * The guard behind `DESKTOP_CONTRACT`.
 *
 * `desktop-contract/inventory.json` lists what an installed Namzu Desktop
 * application relies on. Each recorded name is checked against what the real
 * host offers, started in this process the way the desktop host starts it, and
 * each mirrored shape is checked by a digest that ignores comments and
 * formatting. The page that explains the numbers is `docs/sdk/kernel-facts.md`.
 */

const RULE = [
	'RULE: a change that breaks an already installed Desktop application (a method, notification, flag or file',
	'it relies on removed or renamed; a shape it validates strictly changed so its copy rejects it; something',
	'it hands to the command line no longer means what it did) raises DESKTOP_CONTRACT in',
	'packages/cli/src/desktop-contract.ts, and the new number is recorded in desktop-contract/inventory.json.',
	'An addition an older application ignores only needs the new value recorded in that file.',
	'The inventory and when to raise each number: docs/sdk/kernel-facts.md.',
].join('\n')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

interface Inventory {
	schema: number
	desktopContract: number
	initialize: { agentName: string; answerFieldsRead: string[] }
	coreMethods: string[]
	requiredMethods: string[]
	optionalGroups: Record<string, string[]>
	otherMethods: { methods: string[] }
	notifications: {
		consumed: { name: string; from: string }[]
		requestsFromHost: { name: string; from: string }[]
	}
	flags: {
		host: { command: string; flags: string[] }
		terminalUi: { flags: string[]; permissionModeValues: string[] }
		shortCommands: { command: string; verbs: string[]; flags: string[] }
	}
	kernelFolder: { files: { path: string }[] }
	environment: {
		handsToKernel: { name: string; values?: string[] }[]
		sharedWithKernel: { name: string }[]
	}
	shapes: {
		files: Record<string, { mirroredBy: string; names: string[]; digests: Record<string, string> }>
	}
}

const inventory = JSON.parse(
	readFileSync(join(ROOT, 'desktop-contract', 'inventory.json'), 'utf8'),
) as Inventory

/** Every exported shape of a file: interfaces, type aliases and constant values, not functions or classes. */
function shapeDigests(file: string): Record<string, string> {
	const text = readFileSync(file, 'utf8')
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
	const printer = ts.createPrinter({ removeComments: true })
	const out: Record<string, string> = {}
	const digest = (node: ts.Node) =>
		createHash('sha256')
			.update(
				printer
					.printNode(ts.EmitHint.Unspecified, node, source)
					.replace(/\s+/g, ' ')
					.replace(/,\s*([}\])])/g, '$1')
					.trim(),
			)
			.digest('hex')
			.slice(0, 16)
	for (const statement of source.statements) {
		const exported =
			ts.canHaveModifiers(statement) &&
			ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
		if (!exported) continue
		if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
			out[statement.name.text] = digest(statement)
		} else if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				const init = declaration.initializer
				if (!init || ts.isArrowFunction(init) || ts.isFunctionExpression(init)) continue
				if (ts.isIdentifier(declaration.name)) out[declaration.name.text] = digest(declaration)
			}
		}
	}
	return out
}

let root: string
let offered: string[] = []
let answer: AcpInitializeResult
let plainAnswer: AcpInitializeResult

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), 'namzu-desktop-contract-'))
	const cwd = join(root, 'project')
	mkdirSync(join(cwd, '.git'), { recursive: true })
	const ctx = {
		config: {},
		formatter: { name: 'text', print: () => {}, info: () => {}, error: () => {} },
	} as unknown as Parameters<typeof createCliAcpRuntime>[0]
	const { createTerminalHost } = await import('./terminal/host.js')

	const start = async (extensions: boolean, kernelFacts?: Record<string, unknown>) => {
		const owner = createCliAcpRuntime(ctx)
		let receive!: (message: MCPJsonRpcMessage) => void
		let reply!: (message: MCPJsonRpcMessage) => void
		const transport: MCPTransport = {
			connect: async () => {},
			close: async () => {},
			isConnected: () => true,
			onMessage: (handler) => {
				receive = handler
			},
			onClose: () => {},
			onError: () => {},
			send: async (message) => {
				if (message.id === 1) reply(message)
			},
		}
		const terminals = createTerminalHost({ cwd, notify: () => {} })
		const server: ACPServer = new ACPServer({
			transport,
			gateway: owner.gateway,
			commands: new HostCommandRegistry(),
			presenter: createToolPresenter(new ToolManager({ toolsets: [], messages: () => [] })),
			agentInfo: { name: 'namzu', version: 'contract-test' },
			...(kernelFacts ? { kernelFacts } : {}),
			...(extensions
				? {
						extensions: desktopServerExtensions(
							owner,
							cwd,
							{
								getSessionCwd: (id) => server.getSessionCwd(id),
								retrySession: (id, turnId, checkpointId, options) =>
									server.retrySession(id, turnId, checkpointId, options),
							},
							createPalInboxStarter(() => ctx),
							terminals,
						),
					}
				: {}),
		})
		await server.start()
		const waiting = new Promise<MCPJsonRpcMessage>((resolve) => {
			reply = resolve
		})
		receive({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { capabilities: ['permission', 'namzu/tasks'] },
		})
		const result = (await waiting).result as AcpInitializeResult
		await server.stop()
		await terminals.close()
		await owner.close()
		return result
	}
	const { acpKernelFacts } = await import('./commands/acp.js')
	answer = await start(true, acpKernelFacts(true))
	plainAnswer = await start(false, acpKernelFacts(false))
	offered = [...(answer.extensions ?? [])]
})

afterAll(() => removeTempDir(root))

describe('the desktop contract number', () => {
	it('is an integer recorded beside the inventory', () => {
		expect(Number.isInteger(DESKTOP_CONTRACT) && DESKTOP_CONTRACT >= 1).toBe(true)
		expect(
			DESKTOP_CONTRACT,
			`DESKTOP_CONTRACT is ${DESKTOP_CONTRACT}, the inventory records ${inventory.desktopContract}.\n${RULE}`,
		).toBe(inventory.desktopContract)
	})

	it('is told by a desktop host and by no other host', () => {
		expect(answer.kernel).toEqual({
			engine: VERSION,
			dataEpoch: DATA_EPOCH,
			commandLine: CLI_VERSION,
			desktopContract: DESKTOP_CONTRACT,
		})
		expect(plainAnswer.kernel).toEqual({
			engine: VERSION,
			dataEpoch: DATA_EPOCH,
			commandLine: CLI_VERSION,
		})
	})
})

describe('every recorded name still exists in what the host offers', () => {
	it('answers as the application requires', () => {
		expect(answer.agentInfo.name).toBe(inventory.initialize.agentName)
	})

	it('serves the core methods', () => {
		const core = Object.values(ACP_METHODS) as string[]
		const missing = inventory.coreMethods.filter((name) => !core.includes(name))
		expect(missing, `Core methods no longer offered: ${missing.join(', ')}\n${RULE}`).toEqual([])
	})

	it('serves the required methods, every optional group whole, and the unprobed methods', () => {
		const wanted = [
			...inventory.requiredMethods.map((name) => ['required', name]),
			...Object.entries(inventory.optionalGroups).flatMap(([group, names]) =>
				names.map((name) => [`group ${group}`, name]),
			),
			...inventory.otherMethods.methods.map((name) => ['other', name]),
		] as [string, string][]
		const missing = wanted
			.filter(([, name]) => !offered.includes(name))
			.map(([where, name]) => `${name} (${where})`)
		expect(missing, `The desktop host no longer offers: ${missing.join(', ')}\n${RULE}`).toEqual([])
	})

	it('names no method twice and keeps every extension under namzu/', () => {
		const all = [
			...inventory.requiredMethods,
			...Object.values(inventory.optionalGroups).flat(),
			...inventory.otherMethods.methods,
		]
		expect(new Set(all).size).toBe(all.length)
		expect(all.every((name) => name.startsWith('namzu/'))).toBe(true)
	})

	it('sends the notifications the application consumes under the recorded names', () => {
		const sources: Record<string, string> = {
			'sdk ACP_CLIENT_NOTIFICATIONS.SESSION_UPDATE': ACP_CLIENT_NOTIFICATIONS.SESSION_UPDATE,
			'sdk ACP_CLIENT_NOTIFICATIONS.TASK_UPDATE': ACP_CLIENT_NOTIFICATIONS.TASK_UPDATE,
			'cli USAGE_NOTIFICATION': USAGE_NOTIFICATION,
			'cli OUTCOME_NOTIFICATION': OUTCOME_NOTIFICATION,
			'cli TERMINAL_NOTIFICATIONS.data': TERMINAL_NOTIFICATIONS.data,
			'cli TERMINAL_NOTIFICATIONS.exit': TERMINAL_NOTIFICATIONS.exit,
			'sdk ACP_CLIENT_REQUESTS.REQUEST_PERMISSION': ACP_CLIENT_REQUESTS.REQUEST_PERMISSION,
		}
		const recorded = [
			...inventory.notifications.consumed,
			...inventory.notifications.requestsFromHost,
		]
		const wrong = recorded
			.filter((entry) => sources[entry.from] !== entry.name)
			.map((entry) => `${entry.name} (${entry.from} is ${sources[entry.from] ?? 'unknown'})`)
		expect(wrong, `Notification names changed: ${wrong.join(', ')}\n${RULE}`).toEqual([])
	})

	it('keeps the terminal methods the application probes as a group', () => {
		expect(Object.values(TERMINAL_METHODS).sort()).toEqual(
			[...(inventory.optionalGroups.terminals ?? [])].sort(),
		)
	})
})

describe('the flags the application passes', () => {
	it('starts a desktop host with `acp --desktop` and refuses anything else', async () => {
		expect(acpCommand.name).toBe(inventory.flags.host.command)
		for (const flag of inventory.flags.host.flags) expect(acpCommand.help).toContain(flag)
		await expect(
			acpCommand.handler({
				ctx: {} as never,
				rawArgs: ['--not-a-flag'],
			} as never),
		).rejects.toThrow('Unknown ACP argument')
	})

	it('accepts the terminal UI flags and the permission words', async () => {
		let out = ''
		const write = process.stdout.write.bind(process.stdout)
		process.stdout.write = ((chunk: string | Uint8Array): boolean => {
			out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
			return true
		}) as typeof process.stdout.write
		try {
			await runCli({ argv: ['node', 'namzu', '--help'] })
		} finally {
			process.stdout.write = write
		}
		const missing = inventory.flags.terminalUi.flags.filter((flag) => !out.includes(`${flag} `))
		expect(missing, `The terminal UI no longer takes: ${missing.join(', ')}\n${RULE}`).toEqual([])
		const words = inventory.flags.terminalUi.permissionModeValues.filter(
			(word) => !(PERMISSION_MODE_NAMES as readonly string[]).includes(word),
		)
		expect(words, `--permission-mode no longer takes: ${words.join(', ')}\n${RULE}`).toEqual([])
	})

	it('keeps the short `computer` commands', () => {
		expect(inventory.flags.shortCommands.command).toBe('computer')
		for (const word of [
			...inventory.flags.shortCommands.verbs,
			...inventory.flags.shortCommands.flags,
		]) {
			expect(COMPUTER_HELP, `namzu computer no longer documents ${word}\n${RULE}`).toContain(word)
		}
	})
})

describe('what the application reads and hands over', () => {
	it('finds the files it reads in the command line folder', () => {
		const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
			version?: unknown
		}
		expect(typeof pkg.version).toBe('string')
		const sdk = join(ROOT, 'node_modules', '@namzu', 'sdk', 'package.json')
		expect(existsSync(sdk), `${sdk} is missing\n${RULE}`).toBe(true)
		expect(typeof (JSON.parse(readFileSync(sdk, 'utf8')) as { version?: unknown }).version).toBe(
			'string',
		)
		// `dist/bin.js` is built from this file.
		expect(existsSync(join(ROOT, 'src', 'bin.ts'))).toBe(true)
		expect(inventory.kernelFolder.files.map((file) => file.path).sort()).toEqual([
			'dist/bin.js',
			'node_modules/@namzu/sdk/package.json',
			'package.json',
		])
	})

	it('reads the Pal computer folder the installer carries', () => {
		const entry = inventory.environment.handsToKernel.find(
			(item) => item.name === 'NAMZU_PAL_COMPUTER_BUNDLE',
		)
		expect(entry).toBeDefined()
		const folder = join(root, 'pal-computer')
		mkdirSync(folder)
		writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ imageRef: 'example/image:1' }))
		expect(readPalComputerBundle(folder)?.imageRef).toBe('example/image:1')
	})

	it('still names the engines the application chooses between', () => {
		const entry = inventory.environment.handsToKernel.find(
			(item) => item.name === 'NAMZU_PAL_COMPUTER_ENGINE',
		)
		const source = readFileSync(join(ROOT, 'src', 'pals', 'environment.ts'), 'utf8')
		// The check is private to that module, so its own words are what can be read.
		for (const value of entry?.values ?? [])
			expect(source, `engine ${value}\n${RULE}`).toContain(`'${value}'`)
		expect(source).toContain('NAMZU_PAL_COMPUTER_ENGINE must be docker, podman or wslc.')
	})
})

describe('the shapes the application mirrors', () => {
	for (const [file, record] of Object.entries(inventory.shapes.files)) {
		it(`${file} keeps its recorded shapes`, () => {
			const all = shapeDigests(join(ROOT, file))
			const found = Object.fromEntries(
				record.names.filter((name) => name in all).map((name) => [name, all[name] as string]),
			)
			for (const name of record.names)
				expect(name in all, `${name} is no longer exported from ${file}\n${RULE}`).toBe(true)
			const diff: string[] = []
			for (const [name, digest] of Object.entries(found)) {
				if (!(name in record.digests)) diff.push(`added ${name}: ${digest}`)
				else if (record.digests[name] !== digest)
					diff.push(`changed ${name}: ${record.digests[name]} -> ${digest}`)
			}
			for (const name of Object.keys(record.digests))
				if (!(name in found)) diff.push(`removed ${name}`)
			expect(
				diff,
				`${file} (mirrored by ${record.mirroredBy}) differs from the inventory:\n${diff.join('\n')}\n${RULE}`,
			).toEqual([])
		})
	}
})
