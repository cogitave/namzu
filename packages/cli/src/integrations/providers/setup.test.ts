import { describe, expect, it } from 'vitest'
import { describeAccess, runSetupCommand, versionFromProbe } from './setup.js'

describe('setup process ownership', () => {
	it('passes arguments literally and bounds output', async () => {
		const result = await runSetupCommand(
			process.execPath,
			['-e', 'process.stdout.write(process.argv[1]+"x".repeat(9000))', '$(not-a-shell)'],
			{ cwd: process.cwd(), signal: new AbortController().signal, timeoutMs: 3000 },
		)
		expect(result.code).toBe(0)
		expect(result.output).toHaveLength(8000)
	})
	it('reports missing executables and kills timed-out children', async () => {
		const signal = new AbortController().signal
		expect(
			(
				await runSetupCommand('/nonexistent/namzu-setup', [], {
					cwd: process.cwd(),
					signal,
					timeoutMs: 100,
				})
			).code,
		).toBeNull()
		expect(
			(
				await runSetupCommand(process.execPath, ['-e', 'setInterval(()=>{},100)'], {
					cwd: process.cwd(),
					signal,
					timeoutMs: 100,
				})
			).code,
		).toBeNull()
	})
	it('refuses an already cancelled installation before spawning', async () => {
		const abort = new AbortController()
		abort.abort(new Error('cancelled'))
		expect(() =>
			runSetupCommand(process.execPath, [], {
				cwd: process.cwd(),
				signal: abort.signal,
				timeoutMs: 100,
			}),
		).toThrow('cancelled')
	})
})

describe('versionFromProbe', () => {
	it('skips warnings printed before the number', () => {
		expect(
			versionFromProbe(
				'WARNING: proceeding, even though we could not create PATH aliases: no such file 1.2.3\ncodex-cli 0.46.0\n',
			),
		).toBe('0.46.0')
	})
	it('reads a plain number, with or without v', () => {
		expect(versionFromProbe('1.0.31 (Claude Code)')).toBe('1.0.31')
		expect(versionFromProbe('v2.4')).toBe('2.4')
	})
	it('returns nothing when no line carries a number', () => {
		expect(versionFromProbe('WARNING: something\nready')).toBeUndefined()
		expect(versionFromProbe('')).toBeUndefined()
	})
})

describe('describeAccess', () => {
	it('says how a credential was found in plain words, never the source identifier', () => {
		expect(describeAccess({ kind: 'codex-file', path: '/x/auth.json' })).toBe(
			'Signed in with Codex',
		)
		expect(describeAccess({ kind: 'claude-file', path: '/x' })).toBe('Signed in with Claude')
		expect(describeAccess({ kind: 'gemini-file', path: '/x' })).toBe('Signed in with Gemini')
		expect(describeAccess({ kind: 'stored', path: '/x' })).toBe('Signed in with Namzu')
		expect(describeAccess({ kind: 'env', envName: 'OPENAI_API_KEY' })).toBe(
			'Key from your computer’s settings',
		)
		for (const kind of ['codex-file', 'claude-file', 'stored-api-key', 'opencode-file'] as const) {
			expect(describeAccess({ kind, path: '/x' })).not.toMatch(/-file|stored-|\//)
		}
	})
})
