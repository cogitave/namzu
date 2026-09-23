/**
 * The `schedule` and `session_loop` tools exist only where a person can
 * confirm: the interactive TUI. Never in `exec`, a scheduled run, a resident
 * worker, ACP, or a sub-agent (whose registry `createAgentSession` builds
 * separately from the host's `extraTools`).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../../', import.meta.url))

function sources(dir: string): string[] {
	const out: string[] = []
	for (const name of readdirSync(dir)) {
		const path = join(dir, name)
		if (statSync(path).isDirectory()) {
			if (name === '__tests__' || name === '__fixtures__') continue
			out.push(...sources(path))
		} else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path)
	}
	return out
}

function filesMentioning(pattern: RegExp): string[] {
	return sources(SRC)
		.filter((file) => pattern.test(readFileSync(file, 'utf8')))
		.map((file) => relative(SRC, file).replaceAll('\\', '/'))
		.sort()
}

describe('where the schedule tools are registered', () => {
	it('only the TUI integration builds them', () => {
		expect(filesMentioning(/buildScheduleTools|buildSessionLoopTools/)).toEqual([
			'tui/schedule/integration.ts',
		])
	})

	it('only the App hands a session extra tools, and agent.ts adds them to the main registry alone', () => {
		expect(filesMentioning(/extraTools:/)).toEqual(['tui/App.tsx'])
		const agent = readFileSync(join(SRC, 'tui/agent.ts'), 'utf8')
		const buildToolsAt = agent.indexOf('buildTools: () => {')
		const extraAt = agent.indexOf(
			'for (const tool of options.extraTools ?? []) registry.register(tool)',
		)
		expect(extraAt).toBeGreaterThan(buildToolsAt)
		const buildToolsBody = agent.slice(
			buildToolsAt,
			agent.indexOf('authorizationGate: gateFor(options.rules),', buildToolsAt),
		)
		expect(buildToolsBody).not.toContain('extraTools')
	})

	it('a scheduled run never offers the question tool or the schedule tools', () => {
		const fire = readFileSync(join(SRC, 'schedule/fire/fire.ts'), 'utf8')
		expect(fire).not.toMatch(/askUser:\s*true/)
		expect(fire).not.toContain('extraTools')
	})
})
