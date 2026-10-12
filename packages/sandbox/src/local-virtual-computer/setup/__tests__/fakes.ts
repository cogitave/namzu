import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalCommandError, type LocalComputerCommandRunner } from '../../engine.js'
import type { WslcImageManifest, WslcSetupHost } from '../contract.js'

export const IMAGE_REF = 'namzu-local-computer:2'
export const IMAGE_ID = `sha256:${'a'.repeat(64)}`

/** What `wsl.exe --version` writes through a pipe: UTF-16LE, seen as bytes. */
export function utf16(text: string): string {
	return Buffer.from(text, 'utf16le').toString('latin1')
}

export const WSL_ENGLISH = utf16('WSL version: 3.0.1.0\r\nKernel version: 6.18.20.1\r\n')
export const WSL_TURKISH = utf16('WSL sürümü: 3.0.1.0\r\nÇekirdek sürümü: 6.18.20.1\r\n')

export type Reply = string | Error | (() => string | Error)

export interface FakeRunner extends LocalComputerCommandRunner {
	readonly calls: string[]
	set(key: string, reply: Reply): void
}

function keyOf(binary: string, args: readonly string[]): string {
	const name = /([^\\/]+?)(?:\.exe)?$/i.exec(binary)?.[1] ?? binary
	return [name, ...args].join(' ')
}

export function failure(code: number, codes: string[] = []): LocalCommandError {
	return new LocalCommandError(`The local container engine command failed (${code})`, codes, code)
}

/** A runner that answers by `name arg arg`; anything unlisted fails with status 1. */
export function fakeRunner(replies: Record<string, Reply>): FakeRunner {
	const table = new Map(Object.entries(replies))
	const calls: string[] = []
	return {
		calls,
		set: (key, reply) => {
			table.set(key, reply)
		},
		async run(binary, args) {
			const key = keyOf(binary, args)
			calls.push(key)
			let reply = table.get(key)
			if (typeof reply === 'function') reply = reply()
			if (reply === undefined) throw failure(1)
			if (reply instanceof Error) throw reply
			return reply
		},
	}
}

export interface Scenario {
	/** HNS and vmcompute exist. */
	vmp?: boolean
	lxss?: boolean
	hypervisor?: 'True' | 'False' | 'garbage'
	wsl?: string | null
	wslc?: string | null
	policy?: { AllowWSL?: number; AllowWSLContainer?: number }
	imageInspect?: Reply
}

const MISSING_SERVICE = failure(1060)

/** The runner of a healthy Windows 10 PC, adjusted by `scenario`. */
export function windowsRunner(scenario: Scenario = {}): FakeRunner {
	const vmp = scenario.vmp ?? true
	const wslc = scenario.wslc === undefined ? 'wslc 3.0.1.0\r\n' : scenario.wslc
	const wsl = scenario.wsl === undefined ? WSL_ENGLISH : scenario.wsl
	return fakeRunner({
		'sc query HNS': vmp ? 'SERVICE_NAME: HNS' : MISSING_SERVICE,
		'sc query vmcompute': vmp ? 'SERVICE_NAME: vmcompute' : MISSING_SERVICE,
		'sc query LxssManager': (scenario.lxss ?? true) ? 'SERVICE_NAME: LxssManager' : MISSING_SERVICE,
		'powershell -NoProfile -NonInteractive -Command (Get-CimInstance Win32_ComputerSystem).HypervisorPresent': `${scenario.hypervisor ?? 'True'}\r\n`,
		// The parents of Windows' pending-restart markers list their subkeys; a
		// key that is not listed is absent (the key itself answers exit 1).
		'reg query HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing':
			'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\Packages\r\n',
		'reg query HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update':
			'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\Results\r\n',
		...(wsl === null ? {} : { 'wsl --version': wsl }),
		...(wslc === null ? {} : { 'wslc version': wslc }),
		'wslc image inspect -f json namzu-local-computer:2':
			scenario.imageInspect ?? failure(1, ['WSLC_E_IMAGE_NOT_FOUND']),
	})
}

export interface HostOptions {
	stateDirectory: string
	runner: LocalComputerCommandRunner
	windowsBuild?: number
	platform?: NodeJS.Platform
	arch?: string
	policy?: { AllowWSL?: number; AllowWSLContainer?: number }
	bootTime?: Date
	now?: Date
}

export function fakeHost(options: HostOptions): Partial<WslcSetupHost> {
	return {
		platform: options.platform ?? 'win32',
		arch: options.arch ?? 'x64',
		windowsBuild: options.windowsBuild ?? 19045,
		env: { ProgramFiles: 'C:\\Program Files' },
		runner: options.runner,
		stateDirectory: options.stateDirectory,
		resumeRegistryKey: 'HKCU\\Software\\NamzuTest',
		readDword: async (_key, name) => (options.policy as Record<string, number> | undefined)?.[name],
		bootTime: async () => options.bootTime ?? new Date('2026-10-12T08:00:00.000Z'),
		now: () => options.now ?? new Date('2026-10-12T12:00:00.000Z'),
	}
}

export async function tempDirectory(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'namzu-setup-test-'))
}

export const MANIFEST: WslcImageManifest = {
	revision: 2,
	stage: 'base',
	imageRef: IMAGE_REF,
	imageId: IMAGE_ID,
	protocol: '1',
	file: 'namzu-local-computer-2.tar.zst',
	sha256: '0'.repeat(64),
	tarSha256: '1'.repeat(64),
	sizeBytes: 1_200_000_000,
	compressedBytes: 323_000_000,
	format: 'zst',
}

/** Write a manifest and an archive of `content` beside it; returns the manifest path. */
export async function writeBundle(
	directory: string,
	content: Buffer,
	sha256: string,
	overrides: Partial<WslcImageManifest> = {},
): Promise<{ manifestPath: string; archivePath: string; manifest: WslcImageManifest }> {
	const manifest: WslcImageManifest = {
		...MANIFEST,
		sha256,
		compressedBytes: content.byteLength,
		...overrides,
	}
	const archivePath = join(directory, manifest.file)
	const manifestPath = join(directory, 'manifest.json')
	await writeFile(archivePath, content)
	await writeFile(manifestPath, JSON.stringify(manifest))
	return { manifestPath, archivePath, manifest }
}

export function inspectJson(id: string, protocol = '1'): string {
	return JSON.stringify([
		{ Id: id, Config: { Labels: { 'org.namzu.local-computer.protocol': protocol } } },
	])
}
