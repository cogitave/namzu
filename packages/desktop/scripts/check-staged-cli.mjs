// Prove a staged CLI works from its own files. Run on the staged tree, in a place the workspace's
// node_modules cannot be found from (the staging folder is outside the repository, and the child
// processes get no NODE_PATH), it checks that
//   (a) `bin.js --version` prints the version of the CLI's package.json,
//   (b) `bin.js acp --desktop` answers `initialize`, the first call the Desktop makes,
//   (c) every package specifier the emitted chunks import, and every external the bundle declares,
//       resolves from the staged tree, and imports for the platform running this check. A package
//       with a native part that only loads on the target platform is not imported when the host is
//       another platform; its files for the target are asserted to exist instead.
// It never waits on a clock: a child that hangs is the caller's timeout to catch.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	NOT_SHIPPED,
	appliesToTarget,
	findPackage,
	isPackageSpecifier,
	isPlatformPackage,
	packageNameOf,
} from './lean-cli.mjs'

// The module-loader words an AMD wrapper lists beside its real dependencies.
const AMD_PSEUDO = new Set(['exports', 'module', 'require'])
const typescript = createRequire(import.meta.url)('typescript')

/**
 * The package specifiers a folder of emitted JavaScript imports, with the first file naming each.
 * TypeScript's pre-processor tokenises the file, so a specifier in a string, a comment or generated
 * code held in a template is not an import and is not reported. Static imports, `import("x")` and
 * `require("x")` with a literal specifier are.
 */
export function scanSpecifiers(distDir) {
	const found = new Map()
	const visit = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name)
			if (entry.isDirectory()) visit(path)
			else if (/\.(c|m)?js$/.test(entry.name)) {
				const { importedFiles } = typescript.preProcessFile(readFileSync(path, 'utf8'), true, true)
				for (const { fileName } of importedFiles)
					if (isPackageSpecifier(fileName) && !AMD_PSEUDO.has(fileName) && !found.has(fileName)) found.set(fileName, path)
			}
		}
	}
	visit(distDir)
	return found
}

/**
 * Does a kept package ship a binary for the target? A package with a `prebuilds/<target>` folder
 * does; one with platform packages among its optional dependencies does when the one for the target
 * is in the tree. Returns `undefined` for a package that has no native part at all.
 */
export function nativeStatus(packageDir, root, target, host = { platform: process.platform, arch: process.arch }) {
	const meta = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
	const targetName = `${target.platform}-${target.arch}`
	const prebuilds = join(packageDir, 'prebuilds')
	if (existsSync(prebuilds)) {
		const shipped = existsSync(join(prebuilds, targetName)) && readdirSync(join(prebuilds, targetName)).length > 0
		// A package with no prebuild for the platform is compiled on it, into build/Release; that
		// counts only where the target is the machine that did the compiling.
		const built = host.platform === target.platform && host.arch === target.arch && existsSync(join(packageDir, 'build', 'Release'))
		return { name: meta.name, native: true, hasTarget: shipped || built, detail: `prebuilds/${targetName}` }
	}
	const platformDeps = []
	for (const name of Object.keys(meta.optionalDependencies ?? {})) {
		const dir = findPackage(name, packageDir, root)
		if (dir) {
			const depMeta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
			if (isPlatformPackage(depMeta)) platformDeps.push({ name, applies: appliesToTarget(depMeta, target) })
		} else platformDeps.push({ name, applies: false, absent: true })
	}
	const wanted = platformDeps.filter((dep) => !dep.absent || /(^|[-/])(win32|win|darwin|linux|linuxmusl)[-.]/.test(dep.name))
	if (wanted.length === 0 && !isPlatformPackage(meta)) return undefined
	if (isPlatformPackage(meta)) return { name: meta.name, native: true, hasTarget: appliesToTarget(meta, target), detail: 'os/cpu' }
	return {
		name: meta.name,
		native: true,
		hasTarget: wanted.some((dep) => dep.applies && !dep.absent),
		detail: `a platform package for ${targetName} (optional dependencies: ${wanted.length})`,
	}
}

function childEnv(home) {
	const env = { ...process.env, HOME: home, USERPROFILE: home, NAMZU_HOME: join(home, 'namzu'), CI: 'true' }
	for (const key of Object.keys(env)) if (key === 'NODE_PATH' || key.startsWith('WSL')) delete env[key]
	return env
}

function runToEnd(program, args, options) {
	return new Promise((resolve, reject) => {
		const child = spawn(program, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', (chunk) => {
			stdout += chunk
		})
		child.stderr.on('data', (chunk) => {
			stderr += chunk
		})
		child.on('error', reject)
		child.on('close', (code) => resolve({ code, stdout, stderr }))
	})
}

const INITIALIZE = {
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: {
		protocolVersion: 1,
		capabilities: ['permission', 'namzu/tasks'],
		clientInfo: { name: 'namzu-desktop', version: '0.0.0' },
	},
}

function initializeReply(program, args, options) {
	return new Promise((resolve, reject) => {
		const child = spawn(program, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
		let buffer = ''
		let stderr = ''
		let answered = false
		child.stderr.on('data', (chunk) => {
			stderr += chunk
		})
		child.stdout.on('data', (chunk) => {
			buffer += chunk
			for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
				const line = buffer.slice(0, at)
				buffer = buffer.slice(at + 1)
				let message
				try {
					message = JSON.parse(line)
				} catch {
					continue
				}
				if (message.id === 1 && !answered) {
					answered = true
					child.kill('SIGTERM')
					resolve(message)
				}
			}
		})
		child.on('error', reject)
		child.on('close', (code) => {
			if (!answered) reject(new Error(`acp --desktop exited (${code}) before answering initialize: ${stderr.trim().slice(-600)}`))
		})
		child.stdin.write(`${JSON.stringify(INITIALIZE)}\n`)
	})
}

const PROBE = `
const specifiers = JSON.parse(process.argv[1])
const importIt = JSON.parse(process.argv[2])
const out = []
for (const specifier of specifiers) {
	let resolved
	try { resolved = import.meta.resolve(specifier) } catch (error) { out.push({ specifier, stage: 'resolve', message: String(error && error.message || error).split('\\n')[0] }); continue }
	if (!importIt.includes(specifier)) continue
	try { await import(specifier) } catch (error) { out.push({ specifier, stage: 'import', message: String(error && error.message || error).split('\\n')[0] }) }
}
console.log(JSON.stringify(out))
`

/**
 * Run the checks against a staged CLI (the folder holding package.json, dist and node_modules).
 * Returns `{ failures, report }`: an empty `failures` is a pass. `timings` are measurements only.
 */
export async function checkStagedCli({ cliDir, externals, target, host = { platform: process.platform, arch: process.arch }, node = process.execPath }) {
	const failures = []
	const report = { version: undefined, timings: {}, specifiers: 0, imported: 0, notImported: [], notShipped: [], nativeMissing: [] }
	const home = mkdtempSync(join(tmpdir(), 'namzu-staged-check-'))
	const project = join(home, 'project')
	mkdirSync(project)
	mkdirSync(join(home, 'namzu'))
	try {
		const options = { cwd: project, env: childEnv(home) }
		const bin = join(cliDir, 'dist', 'bin.js')
		const expected = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8')).version

		let started = process.hrtime.bigint()
		const version = await runToEnd(node, [bin, '--version'], options)
		report.timings.versionMs = Number(process.hrtime.bigint() - started) / 1e6
		report.version = version.stdout.trim()
		if (version.code !== 0 || !version.stdout.includes(expected))
			failures.push(`--version: expected ${expected}, got exit ${version.code}, stdout "${version.stdout.trim()}", stderr "${version.stderr.trim().slice(-400)}"`)

		started = process.hrtime.bigint()
		try {
			const reply = await initializeReply(node, [bin, 'acp', '--desktop'], options)
			report.timings.initializeMs = Number(process.hrtime.bigint() - started) / 1e6
			if (reply.error || !reply.result) failures.push(`acp --desktop: initialize returned ${JSON.stringify(reply).slice(0, 300)}`)
		} catch (error) {
			failures.push(`acp --desktop: ${error.message}`)
		}

		// (c) the specifiers in the chunk graph, plus the declared externals.
		const specifiers = scanSpecifiers(join(cliDir, 'dist'))
		for (const name of externals) if (!specifiers.has(name)) specifiers.set(name, '(declared external)')
		const nativeNames = new Set()
		const natives = new Map()
		for (const specifier of specifiers.keys()) {
			const dir = findPackage(packageNameOf(specifier), cliDir, cliDir)
			if (!dir) continue
			const status = nativeStatus(dir, cliDir, target, host)
			if (status) {
				nativeNames.add(packageNameOf(specifier))
				natives.set(status.name, status)
			}
		}
		const crossTarget = host.platform !== target.platform || host.arch !== target.arch
		const toTry = []
		for (const specifier of [...specifiers.keys()].sort()) {
			const name = packageNameOf(specifier)
			if (name in NOT_SHIPPED && !findPackage(name, cliDir, cliDir)) {
				report.notShipped.push(name)
				continue
			}
			toTry.push(specifier)
		}
		const importIt = toTry.filter((specifier) => !(crossTarget && nativeNames.has(packageNameOf(specifier))))
		report.notImported = toTry.filter((specifier) => !importIt.includes(specifier))
		report.specifiers = toTry.length
		const probe = await runToEnd(node, ['--input-type=module', '-e', PROBE, JSON.stringify(toTry), JSON.stringify(importIt)], {
			...options,
			cwd: cliDir,
		})
		if (probe.code !== 0) failures.push(`the import probe failed to run: ${probe.stderr.trim().slice(-400)}`)
		else {
			const bad = JSON.parse(probe.stdout.trim().split('\n').pop())
			report.imported = importIt.length - bad.filter((entry) => entry.stage === 'import').length
			for (const entry of bad)
				failures.push(`${entry.specifier} (named in ${String(specifiers.get(entry.specifier)).split(/[\\/]dist[\\/]/).pop()}) does not ${entry.stage} from the staged tree: ${entry.message}`)
		}
		// Natives: files for the target must exist. node-pty is required; the others only warn when
		// the staging machine is not the target, because a deploy fetches the host's optional packages.
		for (const status of natives.values()) {
			if (status.hasTarget) continue
			if (crossTarget && status.name !== 'node-pty') report.nativeMissing.push(`${status.name}: ${status.detail}`)
			else failures.push(`${status.name} has no binary for ${target.platform}-${target.arch} (${status.detail}).`)
		}
	} finally {
		rmSync(home, { recursive: true, force: true })
	}
	return { failures, report }
}
