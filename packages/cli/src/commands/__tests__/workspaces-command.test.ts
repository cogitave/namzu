import { describe, expect, it, vi } from 'vitest'
import { type WorkspacesDeps, runWorkspaces } from '../workspaces.js'

function deps(over: Partial<WorkspacesDeps> = {}) {
	const errors: string[] = []
	const runPlain = vi.fn(async () => 7)
	const value: WorkspacesDeps = {
		stdin: { isTTY: true } as NodeJS.ReadStream,
		stdout: { isTTY: true } as NodeJS.WriteStream,
		stderr: { write: (text: string) => void errors.push(text) },
		env: {},
		cwd: '/work',
		entry: '/dist/bin.js',
		loadPty: async () => {
			throw new Error('the terminal component failed to load\nmore detail')
		},
		runPlain,
		...over,
	}
	return { value, errors, runPlain }
}

describe('namzu workspaces', () => {
	it('needs an interactive terminal', async () => {
		const d = deps({ stdout: { isTTY: false } as NodeJS.WriteStream })
		expect(await runWorkspaces([], undefined, d.value)).toBe(1)
		expect(d.errors.join('')).toContain('interactive terminal')
		expect(d.runPlain).not.toHaveBeenCalled()
	})

	it('falls back to one plain session with a one-line reason when no pseudo-terminal is available', async () => {
		const d = deps()
		expect(await runWorkspaces(['--model', 'x'], undefined, d.value)).toBe(7)
		expect(d.errors.join('')).toBe(
			'Workspaces needs a terminal component that is not available here (the terminal component failed to load). Starting a single session instead. Run "namzu doctor" to see how to get it.\n',
		)
		expect(d.runPlain).toHaveBeenCalledWith(process.execPath, ['/dist/bin.js', '--model', 'x'])
	})
})
