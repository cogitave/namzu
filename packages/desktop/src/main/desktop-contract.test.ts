import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OUTCOME_NOTIFICATION } from '../shared/outcome-protocol.js'
import { TERMINAL_NOTIFICATIONS } from '../shared/terminal-protocol.js'
import { buildEngineLaunch, namzuPermissionArgument } from '../shared/terminal-tabs.js'
import { USAGE_NOTIFICATION } from '../shared/usage-protocol.js'
import { OPTIONAL_EXTENSION_GROUPS } from './extension-groups.js'
import { KERNEL_CONTRACT_RANGE } from './kernel/keys.js'
import {
	DESKTOP_CLIENT_CAPABILITIES,
	DESKTOP_CLIENT_NAME,
	REQUIRED_EXTENSIONS,
	desktopInitializeParams,
} from './required-extensions.js'
import { desktopRuntimeNodeArgs } from './runtime-node-args.js'

/**
 * The guard on the app's side of the desktop contract. packages/cli/desktop-contract/inventory.json
 * records what an installed Desktop app relies on from the engine, and the engine's own test
 * (packages/cli/src/desktop-contract.test.ts) holds the engine to it. This test holds the APP to the
 * same file: when the app starts relying on something that the inventory does not list (a method it
 * calls, a notification it consumes, a flag it passes, an optional group it probes), or stops, it
 * fails here, so the engine's guard is never blind to it.
 */

const here = dirname(fileURLToPath(import.meta.url))
const inventory = JSON.parse(
	readFileSync(join(here, '..', '..', '..', 'cli', 'desktop-contract', 'inventory.json'), 'utf8'),
) as {
	desktopContract: number
	initialize: {
		client: { protocolVersion: number; capabilities: string[]; clientInfoName: string }
		answerFieldsRead: string[]
		agentName: string
	}
	coreMethods: string[]
	requiredMethods: string[]
	optionalGroups: Record<string, string[]>
	otherMethods: { methods: string[] }
	notifications: {
		consumed: { name: string }[]
		requestsFromHost: { name: string }[]
	}
	flags: {
		host: { command: string; flags: string[] }
		terminalUi: { flags: string[]; permissionModeValues: string[] }
		shortCommands: { command: string; verbs: string[]; flags: string[] }
	}
	kernelFolder: { files: { path: string }[] }
	environment: {
		handsToKernel: { name: string }[]
		sharedWithKernel: { name: string }[]
	}
}

/** Every non-test source file of the app's main process, as text. */
function mainSources(): Map<string, string> {
	const out = new Map<string, string>()
	const walk = (folder: string) => {
		for (const entry of readdirSync(folder, { withFileTypes: true })) {
			const path = join(folder, entry.name)
			if (entry.isDirectory()) walk(path)
			else if (/\.ts$/u.test(entry.name) && !/\.test\.ts$/u.test(entry.name))
				out.set(path.slice(here.length + 1), readFileSync(path, 'utf8'))
		}
	}
	walk(here)
	return out
}
const sources = mainSources()
const source = (name: string) => sources.get(name) ?? ''
const sorted = (values: Iterable<string>) => [...new Set(values)].sort()

describe('the app against the desktop contract inventory', () => {
	it('accepts the contract number the inventory records', () => {
		expect(inventory.desktopContract).toBeGreaterThanOrEqual(KERNEL_CONTRACT_RANGE[0])
		expect(inventory.desktopContract).toBeLessThanOrEqual(KERNEL_CONTRACT_RANGE[1])
	})

	it('introduces itself to the host as the inventory says', () => {
		const params = desktopInitializeParams('1.2.3')
		expect(params.protocolVersion).toBe(inventory.initialize.client.protocolVersion)
		expect([...params.capabilities]).toEqual(inventory.initialize.client.capabilities)
		expect(params.clientInfo.name).toBe(inventory.initialize.client.clientInfoName)
		expect(DESKTOP_CLIENT_NAME).toBe(inventory.initialize.client.clientInfoName)
		expect([...DESKTOP_CLIENT_CAPABILITIES]).toEqual(inventory.initialize.client.capabilities)
	})

	it('reads from the initialize answer exactly the fields the inventory lists', () => {
		const text = source('rpc-client.ts')
		const start = text.indexOf("'initialize',")
		const end = text.indexOf('REQUIRED_EXTENSIONS.every', start)
		expect(start).toBeGreaterThan(-1)
		expect(end).toBeGreaterThan(start)
		const read = new Set<string>()
		for (const match of text.slice(start, end).matchAll(/\bresult\.(\w+(?:\?\.\w+)?)/gu))
			read.add((match[1] as string).replace('?.', '.').replace(/\.includes$/u, ''))
		expect(sorted(read)).toEqual(sorted(inventory.initialize.answerFieldsRead))
		expect(text).toContain(`'${inventory.initialize.agentName}'`)
	})

	it('lists the same required methods', () => {
		expect(sorted(REQUIRED_EXTENSIONS)).toEqual(sorted(inventory.requiredMethods))
	})

	it('probes the same optional groups, group by group', () => {
		expect(Object.keys(OPTIONAL_EXTENSION_GROUPS).sort()).toEqual(
			Object.keys(inventory.optionalGroups).sort(),
		)
		for (const [group, methods] of Object.entries(inventory.optionalGroups))
			expect(
				sorted((OPTIONAL_EXTENSION_GROUPS as Record<string, readonly string[]>)[group] ?? []),
				group,
			).toEqual(sorted(methods))
	})

	it('names no method of the engine that the inventory does not record', () => {
		const recorded = new Set<string>([
			...inventory.coreMethods,
			...inventory.requiredMethods,
			...Object.values(inventory.optionalGroups).flat(),
			...inventory.otherMethods.methods,
			...inventory.notifications.consumed.map((entry) => entry.name),
			...inventory.notifications.requestsFromHost.map((entry) => entry.name),
		])
		// `namzu/tasks` is a capability the app announces, not a method (see `initialize.client`).
		const notMethods = new Set(['namzu/tasks', ...inventory.initialize.client.capabilities])
		const unrecorded: string[] = []
		for (const [file, text] of sources) {
			if (file.startsWith('kernel/')) continue
			for (const match of text.matchAll(/'(namzu\/[a-z0-9_/-]+)'/gu)) {
				const name = match[1] as string
				if (!recorded.has(name) && !notMethods.has(name)) unrecorded.push(`${name} (${file})`)
			}
		}
		expect(sorted(unrecorded)).toEqual([])
	})

	it('still uses every method the inventory lists as called without probing, and every core method', () => {
		const all = [...sources.values()].join('\n')
		for (const method of [...inventory.otherMethods.methods, ...inventory.coreMethods])
			expect(all, method).toContain(`'${method}'`)
	})

	it('consumes the notifications and requests the inventory lists, and no other', () => {
		const consumed = new Set<string>([
			USAGE_NOTIFICATION,
			OUTCOME_NOTIFICATION,
			TERMINAL_NOTIFICATIONS.data,
			TERMINAL_NOTIFICATIONS.exit,
		])
		for (const [file, text] of sources) {
			if (file.startsWith('kernel/')) continue
			for (const match of text.matchAll(/(?<!typeof )\bframe\.method === '([^']+)'/gu))
				consumed.add(match[1] as string)
		}
		const recorded = [
			...inventory.notifications.consumed,
			...inventory.notifications.requestsFromHost,
		].map((entry) => entry.name)
		expect(sorted(consumed)).toEqual(sorted(recorded))
	})

	it('starts the host and the terminal UI with the flags the inventory lists', () => {
		expect(
			desktopRuntimeNodeArgs('/x/dist/bin.js', { platform: 'linux' } as never).slice(-2),
		).toEqual([inventory.flags.host.command, ...inventory.flags.host.flags])
		const modes = [
			'prompt',
			'accept-edits',
			'plan',
			'bypass',
			'auto',
			'strict',
			'classify',
		] as const
		const flags = new Set<string>()
		const values = new Set<string>()
		for (const mode of modes) {
			const launch = buildEngineLaunch(
				{
					engine: 'namzu',
					provider: 'p',
					model: 'm',
					effort: 'high',
					permissionMode: mode,
					prompt: 'hello',
				},
				{
					platform: 'linux',
					execPath: '/x/electron',
					nodeArgs: [],
					cliEntry: '/x/dist/bin.js',
				} as never,
				{ name: 'project' },
			)
			const args = launch.args ?? []
			for (const arg of args.slice(args.indexOf('/x/dist/bin.js') + 1))
				if (arg.startsWith('--')) flags.add(arg.split('=')[0] as string)
			values.add(namzuPermissionArgument(mode))
		}
		expect(sorted(flags)).toEqual(sorted(inventory.flags.terminalUi.flags))
		expect(sorted(values)).toEqual(sorted(inventory.flags.terminalUi.permissionModeValues))
	})

	it('runs the short commands with the verbs and flags the inventory lists', () => {
		const text = source('pal-computer-setup.ts')
		const verbs = new Set<string>()
		for (const match of text.matchAll(/'computer',\s*'([a-z-]+)'/gu)) verbs.add(match[1] as string)
		const flags = new Set<string>()
		for (const match of text.matchAll(/'(--[a-z-]+)'/gu)) flags.add(match[1] as string)
		expect(sorted(verbs)).toEqual(sorted(inventory.flags.shortCommands.verbs))
		// The inventory may be wider than the app (it also lists --yes and --bundle, which the setup flow
		// does not pass today); what the app passes must always be listed.
		expect(
			sorted(flags).filter((flag) => !inventory.flags.shortCommands.flags.includes(flag)),
		).toEqual([])
		expect(inventory.flags.shortCommands.flags).toEqual(expect.arrayContaining(sorted(flags)))
	})

	it('reads the engine folder files the inventory lists', () => {
		const text = `${source('runtime-versions.ts')}\n${source('bundled-runtime.ts')}`
		for (const { path } of inventory.kernelFolder.files) {
			const parts = path.split('/')
			for (const part of parts) expect(text, path).toContain(`'${part}'`)
		}
	})

	it('hands the engine the environment the inventory lists', () => {
		const all = [...sources.values()].join('\n')
		for (const { name } of [
			...inventory.environment.handsToKernel,
			...inventory.environment.sharedWithKernel,
		])
			expect(all, name).toContain(name)
	})
})
