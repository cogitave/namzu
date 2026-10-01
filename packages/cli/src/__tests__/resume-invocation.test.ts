import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { resumeInvocation } from '../resume-invocation.js'
import { formatTuiExitSummary } from '../tui/exit-summary.js'

// Exercise native Windows resolution on every host without executing a batch
// file or relying on a developer's global npm installation.
const windowsFs = vi.hoisted(() => ({
	enabled: false,
	files: new Map<
		string,
		{ content?: string; canonical?: string; unreadable?: boolean; inaccessible?: boolean }
	>(),
}))

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>()
	function fixture(path: unknown) {
		const file = windowsFs.files.get(String(path))
		if (!file) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' })
		return file
	}
	return {
		...actual,
		accessSync: ((path: Parameters<typeof actual.accessSync>[0], mode?: number) => {
			if (!windowsFs.enabled) return actual.accessSync(path, mode)
			if (fixture(path).inaccessible)
				throw Object.assign(new Error('inaccessible fixture'), { code: 'EACCES' })
		}) as typeof actual.accessSync,
		readFileSync: ((path: Parameters<typeof actual.readFileSync>[0], options?: unknown) => {
			if (!windowsFs.enabled) return actual.readFileSync(path, options as never)
			const file = fixture(path)
			if (file.unreadable) throw Object.assign(new Error('unreadable fixture'), { code: 'EACCES' })
			return file.content ?? ''
		}) as typeof actual.readFileSync,
		realpathSync: ((path: Parameters<typeof actual.realpathSync>[0]) => {
			if (!windowsFs.enabled) return actual.realpathSync(path)
			return fixture(path).canonical ?? String(path)
		}) as typeof actual.realpathSync,
	}
})

/** The Node shim emitted by npm's cmd-shim, including its CRLF line endings. */
function npmCmdShim(target: string): string {
	return `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*
`.replaceAll('\n', '\r\n')
}

function windowsInstall(directory: string): string {
	const target = 'node_modules\\@namzu\\cli\\dist\\bin.js'
	const entry = win32.join(directory, target)
	windowsFs.files.set(entry, { canonical: entry })
	windowsFs.files.set(win32.join(directory, 'namzu.cmd'), { content: npmCmdShim(target) })
	return entry
}

describe('Windows public resume command', () => {
	beforeEach(() => {
		windowsFs.enabled = true
		windowsFs.files.clear()
	})
	afterEach(() => {
		windowsFs.enabled = false
		windowsFs.files.clear()
	})

	it('uses the matching npm .cmd shim from a prefix containing spaces', () => {
		const directory = 'C:\\Program Files\\npm'
		const entry = windowsInstall(directory)
		const invocation = resumeInvocation(entry, `C:\\missing;${directory}`, 'win32')
		expect(invocation).toEqual(['namzu.cmd'])
		expect(
			formatTuiExitSummary({ conversationId: 'example' }, { command: invocation }, 'win32'),
		).toBe("To resume this conversation, run in PowerShell: & 'namzu.cmd' 'resume' 'example'\n")
	})

	it('compares canonical entrypoints for npm-linked installations', () => {
		const directory = 'C:\\npm'
		const entry = windowsInstall(directory)
		const canonical = 'D:\\Namzu source\\packages\\cli\\dist\\bin.js'
		windowsFs.files.set(entry, { canonical })
		windowsFs.files.set(canonical, { canonical })
		expect(resumeInvocation(canonical, directory, 'win32')).toEqual(['namzu.cmd'])
	})

	it('keeps the current executable when an earlier npm shim belongs to another installation', () => {
		const first = 'C:\\older npm'
		windowsInstall(first)
		const second = 'D:\\current npm'
		const entry = windowsInstall(second)
		expect(resumeInvocation(entry, `${first};${second}`, 'win32')).toEqual([
			process.execPath,
			entry,
		])
	})

	it('does not mistake a matching .ps1 or extensionless shim for a callable .cmd', () => {
		const directory = 'C:\\npm'
		const entry = win32.join(directory, 'node_modules', '@namzu', 'cli', 'dist', 'bin.js')
		windowsFs.files.set(entry, { canonical: entry })
		windowsFs.files.set(win32.join(directory, 'namzu.ps1'), { content: '' })
		windowsFs.files.set(win32.join(directory, 'namzu'), { canonical: entry })
		expect(resumeInvocation(entry, directory, 'win32')).toEqual([process.execPath, entry])
	})

	it.each(['unrecognized', 'unreadable', 'inaccessible', 'missing target'] as const)(
		'does not skip an earlier %s .cmd to use a later matching one',
		(kind) => {
			const first = 'C:\\first'
			const second = 'C:\\second'
			const entry = windowsInstall(second)
			windowsFs.files.set(win32.join(first, 'namzu.cmd'), {
				content:
					kind === 'unrecognized'
						? '@echo unrelated wrapper\r\n'
						: npmCmdShim('node_modules\\@namzu\\cli\\dist\\bin.js'),
				unreadable: kind === 'unreadable',
				inaccessible: kind === 'inaccessible',
			})
			expect(resumeInvocation(entry, `${first};${second}`, 'win32')).toEqual([
				process.execPath,
				entry,
			])
		},
	)

	it('does not accept a target-looking comment or additional batch commands', () => {
		const directory = 'C:\\npm'
		const entry = windowsInstall(directory)
		const shim = npmCmdShim('node_modules\\@namzu\\cli\\dist\\bin.js')
		for (const content of [`REM ${shim}`, `${shim}@echo unrelated command\r\n`]) {
			windowsFs.files.set(win32.join(directory, 'namzu.cmd'), { content })
			expect(resumeInvocation(entry, directory, 'win32')).toEqual([process.execPath, entry])
		}
	})

	it.each([
		'node_modules\\%PACKAGE%\\bin.js',
		'node_modules\\!PACKAGE!\\bin.js',
		'C:bin.js',
		'\\rooted\\bin.js',
	])('does not trust an expanded or drive-dependent target %j', (target) => {
		const directory = 'C:\\npm'
		const entry = windowsInstall(directory)
		windowsFs.files.set(win32.resolve(directory, target), { canonical: entry })
		windowsFs.files.set(win32.join(directory, 'namzu.cmd'), { content: npmCmdShim(target) })
		expect(resumeInvocation(entry, directory, 'win32')).toEqual([process.execPath, entry])
	})

	it.each(['.', '', 'C:relative', '\\drive-relative'])(
		'preserves provenance behind a relative PATH entry %j',
		(first) => {
			const directory = 'C:\\npm'
			const entry = windowsInstall(directory)
			expect(resumeInvocation(entry, `${first};${directory}`, 'win32')).toEqual([
				process.execPath,
				entry,
			])
		},
	)

	it('retains the loader arguments for a TypeScript entrypoint', () => {
		const directory = 'C:\\npm'
		const entry = win32.join(directory, 'node_modules', '@namzu', 'cli', 'src', 'bin.ts')
		windowsFs.files.set(entry, { canonical: entry })
		windowsFs.files.set(win32.join(directory, 'namzu.cmd'), {
			content: npmCmdShim('node_modules\\@namzu\\cli\\src\\bin.ts'),
		})
		expect(resumeInvocation(entry, directory, 'win32')).toEqual([
			process.execPath,
			...process.execArgv,
			entry,
		])
	})
})

describe.skipIf(process.platform === 'win32')('public resume command', () => {
	it('uses the matching PATH executable, but preserves alternate installations and source loaders', () => {
		const root = mkdtempSync(join(tmpdir(), 'namzu-resume-path-'))
		try {
			const bin = join(root, 'bin')
			mkdirSync(bin)
			const entry = join(root, 'bin.js')
			writeFileSync(entry, '')
			chmodSync(entry, 0o755)
			symlinkSync(entry, join(bin, 'namzu'))
			expect(resumeInvocation(entry, bin)).toEqual(['namzu'])
			expect(resumeInvocation(join(root, 'other.js'), bin)).toEqual([
				process.execPath,
				join(root, 'other.js'),
			])
			expect(resumeInvocation(entry, `.${delimiter}${bin}`)).toEqual([process.execPath, entry])
			const source = join(root, 'bin.ts')
			expect(resumeInvocation(source, bin)).toEqual([process.execPath, ...process.execArgv, source])
		} finally {
			removeTempDir(root)
		}
	})
	it('omits a redundant directory change in the current working directory', () => {
		expect(
			formatTuiExitSummary(
				{ conversationId: 'example' },
				{ cwd: process.cwd(), command: ['namzu'] },
			),
		).toBe('To resume this conversation, run: namzu resume example\n')
	})
})
