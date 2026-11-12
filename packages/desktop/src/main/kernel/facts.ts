import type { AcpKernelFacts } from '@namzu/sdk'
import { inFolder } from './files-list.js'
import type { KernelFs } from './fs.js'
import { isKernelVersion } from './version.js'

/** What a kernel folder says about itself (kernel.json, section 3.1) and what a host answers. */

export const KERNEL_FACTS_FILE = 'kernel.json'

export interface KernelFacts {
	schema: 1
	commandLine: string
	engine: string
	desktopContract: number
	dataEpoch: number
	platform: string
	arch: string
}

export class FactsError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'FactsError'
	}
}

function positiveInt(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

const PLATFORM_WORD = /^[a-z0-9]{1,16}$/u

/** Strict: the five facts, the schema number, and nothing else. */
export function parseKernelFacts(bytes: Uint8Array): KernelFacts {
	let value: unknown
	try {
		value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
	} catch {
		throw new FactsError('kernel.json is not valid JSON.')
	}
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new FactsError('kernel.json is not an object.')
	const record = value as Record<string, unknown>
	const names = [
		'schema',
		'commandLine',
		'engine',
		'desktopContract',
		'dataEpoch',
		'platform',
		'arch',
	]
	for (const key of Object.keys(record))
		if (!names.includes(key)) throw new FactsError(`Unknown field ${key} in kernel.json.`)
	if (
		record.schema !== 1 ||
		!isKernelVersion(record.commandLine) ||
		!isKernelVersion(record.engine) ||
		!positiveInt(record.desktopContract) ||
		!positiveInt(record.dataEpoch) ||
		typeof record.platform !== 'string' ||
		!PLATFORM_WORD.test(record.platform) ||
		typeof record.arch !== 'string' ||
		!PLATFORM_WORD.test(record.arch)
	)
		throw new FactsError('kernel.json has a missing or malformed field.')
	return {
		schema: 1,
		commandLine: record.commandLine,
		engine: record.engine,
		desktopContract: record.desktopContract,
		dataEpoch: record.dataEpoch,
		platform: record.platform,
		arch: record.arch,
	}
}

/** The `kernel` object of an `initialize` answer (the SDK's own type), read leniently; undefined when it has no usable one. */
export function kernelFromInitialize(result: unknown): AcpKernelFacts | undefined {
	if (!result || typeof result !== 'object') return undefined
	const kernel = (result as { kernel?: unknown }).kernel
	if (!kernel || typeof kernel !== 'object' || Array.isArray(kernel)) return undefined
	const record = kernel as Record<string, unknown>
	if (!isKernelVersion(record.engine) || !positiveInt(record.dataEpoch)) return undefined
	return {
		engine: record.engine,
		dataEpoch: record.dataEpoch,
		...(isKernelVersion(record.commandLine) ? { commandLine: record.commandLine } : {}),
		...(positiveInt(record.desktopContract) ? { desktopContract: record.desktopContract } : {}),
	}
}

export interface ExpectedKernel {
	commandLine: string
	engine: string
	desktopContract: number
	dataEpoch: number
}

/**
 * What the self-check compares: the program's own `--version` and its `initialize` answer
 * against what the signed manifest promised. Returns the first thing wrong, in plain words
 * for a log, or undefined when everything agrees. The child process that produces the two
 * inputs belongs to the caller.
 */
export function checkHostAnswer(options: {
	expected: ExpectedKernel
	versionOutput: string
	initialize: unknown
	requiredExtensions: readonly string[]
}): string | undefined {
	const { expected, initialize } = options
	const output = options.versionOutput.trim()
	const lastWord = output.split(/\s+/u).at(-1)
	if (output !== expected.commandLine && lastWord !== expected.commandLine)
		return `--version says ${JSON.stringify(output.slice(0, 80))}, expected ${expected.commandLine}`
	if (!initialize || typeof initialize !== 'object') return 'initialize gave no answer'
	const answer = initialize as { agentInfo?: { name?: unknown }; extensions?: unknown }
	if (answer.agentInfo?.name !== 'namzu') return 'initialize names another program'
	const extensions = Array.isArray(answer.extensions) ? answer.extensions : []
	for (const method of options.requiredExtensions)
		if (!extensions.includes(method)) return `initialize lacks the method ${method}`
	const kernel = kernelFromInitialize(initialize)
	if (!kernel) return 'initialize carries no kernel facts'
	if (kernel.engine !== expected.engine)
		return `the engine is ${kernel.engine}, expected ${expected.engine}`
	if (kernel.dataEpoch !== expected.dataEpoch)
		return `the data epoch is ${kernel.dataEpoch}, expected ${expected.dataEpoch}`
	if (kernel.commandLine !== expected.commandLine)
		return 'the command line version in initialize differs'
	if (kernel.desktopContract !== expected.desktopContract)
		return 'the desktop contract in initialize differs'
	return undefined
}

/** What the bundled engine is, as far as the app can tell. */
export interface BundledFacts {
	commandLine: string
	engine: string
	dataEpoch: number
	desktopContract?: number
}

/**
 * The bundled copy's facts: kernel.json beside it when there is one; otherwise `ask`, a function
 * the caller supplies that runs the bundled program once; otherwise nobody knows, and managed
 * engines are unavailable. Asked at most once per reader.
 */
export function bundledFactsReader(options: {
	fs: KernelFs
	/** The folder that holds the bundled `dist/bin.js`. */
	cliFolder: string
	ask?: () => Promise<AcpKernelFacts & { commandLine: string }>
}): () => Promise<BundledFacts | undefined> {
	let memo: Promise<BundledFacts | undefined> | undefined
	return () => {
		memo ??= (async () => {
			try {
				const facts = parseKernelFacts(
					await options.fs.readFile(inFolder(options.cliFolder, KERNEL_FACTS_FILE)),
				)
				return {
					commandLine: facts.commandLine,
					engine: facts.engine,
					dataEpoch: facts.dataEpoch,
					desktopContract: facts.desktopContract,
				}
			} catch {
				// absent or unreadable: fall through to asking
			}
			if (!options.ask) return undefined
			try {
				const answer = await options.ask()
				if (
					!isKernelVersion(answer.commandLine) ||
					!isKernelVersion(answer.engine) ||
					!positiveInt(answer.dataEpoch)
				)
					return undefined
				return {
					commandLine: answer.commandLine,
					engine: answer.engine,
					dataEpoch: answer.dataEpoch,
					...(positiveInt(answer.desktopContract)
						? { desktopContract: answer.desktopContract }
						: {}),
				}
			} catch {
				return undefined
			}
		})()
		return memo
	}
}
