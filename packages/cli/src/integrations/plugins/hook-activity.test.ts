/**
 * What hooks do beside answering, through the real runtime: a `session_start`
 * hook sets a variable for later commands, a change of folder clears what the
 * old folder's hooks set and runs `cwd_changed`, and `/hooks` shows names (not
 * values) and the files watched.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { renderHooks } from '../../tui/slashCommands.js'
import { createCliPluginRuntime } from './runtime.js'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const project = () => {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-hook-activity-'))
	dirs.push(dir)
	return dir
}

describe('variables set by hooks', () => {
	it('a session_start hook sets one, a cwd_changed hook replaces what the last folder set', async () => {
		const cwd = project()
		const runtime = await createCliPluginRuntime(
			undefined,
			cwd,
			{
				session_start: [{ command: 'echo "export FROM_START=1" >> "$NAMZU_ENV_FILE"' }],
				cwd_changed: [{ command: 'echo "export FOLDER=$(basename "$PWD")" >> "$NAMZU_ENV_FILE"' }],
			},
			{ sessionId: () => 'session-1' },
		)
		if (!runtime) throw new Error('no runtime')
		try {
			const live = runtime.hookActivity.variables
			await runtime.manager.executeHooks('session_start', {
				sessionId: 'session-1' as never,
				source: 'startup',
			})
			expect(live).toEqual({ FROM_START: '1' })
			// The command wrote `$(basename ...)` inside its own shell, which is the
			// hook's business; the line it appended is the plain result.
			const sub = join(cwd, 'sub')
			mkdirSync(sub)
			await runtime.hookActivity.changeDirectory({ from: cwd, to: sub })
			expect(live.FROM_START).toBe('1')
			expect(live.FOLDER).toBe('sub')
			const other = join(cwd, 'other')
			mkdirSync(other)
			await runtime.hookActivity.changeDirectory({ from: sub, to: other })
			expect(live.FOLDER).toBe('other')
			expect(runtime.hookActivity.describe().variables).toEqual([
				{ name: 'FROM_START', event: 'session_start' },
				{ name: 'FOLDER', event: 'cwd_changed' },
			])
		} finally {
			await runtime.close()
		}
	})

	it('refuses a name that would change what runs, and tells the person', async () => {
		const cwd = project()
		const runtime = await createCliPluginRuntime(
			undefined,
			cwd,
			{ session_start: [{ command: 'echo "export LD_PRELOAD=/x.so" >> "$NAMZU_ENV_FILE"' }] },
			{ sessionId: () => 's' },
		)
		if (!runtime) throw new Error('no runtime')
		try {
			const lines: string[] = []
			runtime.hookActivity.onNotice((line) => lines.push(line))
			await runtime.manager.executeHooks('session_start', { sessionId: 's' as never })
			expect(runtime.hookActivity.variables).toEqual({})
			expect(lines).toHaveLength(1)
			expect(lines[0]).toMatch(/LD_PRELOAD is a dynamic loader variable/)
		} finally {
			await runtime.close()
		}
	})

	it('hands a notice given before anyone listened to the first listener', async () => {
		const cwd = project()
		const runtime = await createCliPluginRuntime(
			undefined,
			cwd,
			{ session_start: [{ command: 'echo "NAMZU_HOME=/x" >> "$NAMZU_ENV_FILE"' }] },
			{ sessionId: () => 's' },
		)
		if (!runtime) throw new Error('no runtime')
		try {
			await runtime.manager.executeHooks('session_start', { sessionId: 's' as never })
			const lines: string[] = []
			runtime.hookActivity.onNotice((line) => lines.push(line))
			expect(lines).toHaveLength(1)
		} finally {
			await runtime.close()
		}
	})
})

describe('watching', () => {
	it('watches the matcher paths of file_changed hooks, and nothing when there are none', async () => {
		const cwd = project()
		writeFileSync(join(cwd, '.envrc'), '')
		const none = await createCliPluginRuntime(
			undefined,
			cwd,
			{ session_start: [{ command: 'true' }] },
			{ sessionId: () => 's' },
		)
		const some = await createCliPluginRuntime(
			undefined,
			cwd,
			{ file_changed: [{ command: 'true', matcher: '.envrc|*.json' }] },
			{ sessionId: () => 's' },
		)
		try {
			expect(none?.hookActivity.describe().watching).toEqual([])
			expect(some?.hookActivity.describe().watching).toEqual([join(cwd, '.envrc')])
		} finally {
			await none?.close()
			await some?.close()
		}
	})
})

describe('/hooks', () => {
	it('shows the names of what hooks set and the files watched, never a value', () => {
		const text = renderHooks(
			{ file_changed: [{ command: 'reload.sh', matcher: '.envrc' }] },
			{
				activity: {
					variables: [{ name: 'API_BASE', event: 'session_start' }],
					watching: ['/p/.envrc'],
					notes: [],
				},
			},
		)
		expect(text).toContain('variables set by hooks for shell commands (names only)')
		expect(text).toContain('  API_BASE · set by session_start')
		expect(text).toContain('files watched for file_changed')
		expect(text).toContain('  /p/.envrc')
	})

	it('says under a file_changed hook whose matcher names no file that it watches nothing itself', () => {
		const text = renderHooks({ file_changed: [{ command: 'x' }] }, {})
		expect(text).toContain('note: its matcher names no file')
		expect(renderHooks({ file_changed: [{ command: 'x', matcher: '.envrc' }] }, {})).not.toContain(
			'names no file',
		)
	})
})

describe('/hooks on the worktree events', () => {
	it('says that a matcher, if and once are ignored there, and says nothing when none is set', () => {
		const text = renderHooks(
			{
				worktree_create: [{ command: 'make.sh', matcher: 'x', once: true }],
				worktree_remove: [{ command: 'rm.sh' }],
			},
			{},
		)
		expect(text).toContain('worktree_create')
		expect(text).toContain('its matcher, once are ignored and it always runs')
		expect(text.match(/always runs/g)).toHaveLength(1)
	})
})
