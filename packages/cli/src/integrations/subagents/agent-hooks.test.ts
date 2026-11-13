import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginLifecycleManager, type SessionId } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { createAgentHooksHost, readAgentHooks, refusalLine, vetAgentHooks } from './agent-hooks.js'

/**
 * An agent file's hooks are attached to one run, keyed by the child's session,
 * and fire for that child only. Real commands run under `sh`, so a test that
 * waits for one has Vitest's own per-test timeout as its only clock.
 */

const PARENT = '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as SessionId
const RUN_A = '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5c' as SessionId
const RUN_B = '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5d' as SessionId

function manager(): PluginLifecycleManager {
	const logger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		child: () => logger,
	}
	return new PluginLifecycleManager({
		pluginRegistry: {} as never,
		scopeRoots: { project: process.cwd(), user: process.cwd() },
		log: logger as never,
	})
}

function host(
	setup: { hooksSwitch?: 'disabled' | 'managed-only'; trusted?: boolean; noManager?: boolean } = {},
) {
	const mgr = manager()
	const lines: string[] = []
	const h = createAgentHooksHost({
		manager: () => (setup.noManager ? undefined : mgr),
		hookOptions: () => ({ cwd: process.cwd() }),
		hooksSwitch: () => setup.hooksSwitch,
		projectTrusted: () => setup.trusted ?? true,
	})
	h.subscribe((line) => lines.push(line))
	return { mgr, h, lines }
}

const GUARD = [
	'hooks:',
	'  PreToolUse:',
	'    - matcher: Bash',
	'      hooks:',
	'        - type: command',
	'          command: echo "no" >&2; exit 2',
].join('\n')

const agent = (hooksSource: string, source = 'user', name = 'guarded') => ({
	name,
	path: `/agents/${name}.md`,
	source,
	hooksSource,
})

const preTool = (mgr: PluginLifecycleManager, sessionId: SessionId, toolName = 'bash') =>
	mgr.executeHooks('pre_tool_use', { sessionId, toolName, toolInput: { command: 'ls' } })

describe('reading an agent file’s hooks', () => {
	it('moves a turn_end entry to subagent_stop, without its matcher', () => {
		const read = readAgentHooks(
			[
				'hooks:',
				'  Stop:',
				'    - matcher: anything',
				'      hooks:',
				'        - command: ./done.sh',
			].join('\n'),
			'guarded',
		)
		const entries = read.hooks as unknown as Record<string, { command: string; matcher?: string }[]>
		expect(Object.keys(entries)).toEqual(['subagent_stop'])
		expect(entries.subagent_stop).toHaveLength(1)
		expect(entries.subagent_stop?.[0]?.command).toBe('./done.sh')
		expect(entries.subagent_stop?.[0]?.matcher).toBeUndefined()
	})

	it('runs the same command once when it is written under both Stop and SubagentStop', () => {
		const read = readAgentHooks(
			[
				'hooks:',
				'  Stop:',
				'    - hooks:',
				'        - command: ./done.sh',
				'  SubagentStop:',
				'    - matcher: guarded',
				'      hooks:',
				'        - command: ./done.sh',
				'        - command: ./other.sh',
			].join('\n'),
			'guarded',
		)
		const stop = (read.hooks as unknown as Record<string, { command: string }[]>).subagent_stop
		expect(stop?.map((entry) => entry.command)).toEqual(['./done.sh', './other.sh'])
	})

	it('sets aside an event only the main conversation fires, with a note', () => {
		const read = readAgentHooks(
			['hooks:', '  SessionStart:', '    - hooks:', '        - command: ./x.sh'].join('\n'),
			'guarded',
		)
		expect(read.count).toBe(0)
		expect(read.guardLost).toBe(false)
		expect(read.problems).toEqual([
			expect.objectContaining({ event: 'session_start', severity: 'note' }),
		])
	})

	it('loses the guard when a guarding entry cannot be loaded', () => {
		const read = readAgentHooks(
			[
				'hooks:',
				'  PreToolUse:',
				'    - matcher: Bash',
				'      hooks:',
				'        - type: nope',
			].join('\n'),
			'guarded',
		)
		expect(read.guardLost).toBe(true)
	})
})

describe('which agent files are offered', () => {
	const broken = agent(
		['hooks:', '  PreToolUse:', '    - matcher: Bash', '      hooks:', '        - type: nope'].join(
			'\n',
		),
	)

	it('refuses a file whose guard cannot be loaded, with a line naming the file and the entry', () => {
		const { offered, refused } = vetAgentHooks([broken, agent(GUARD, 'user', 'fine')], {
			projectTrusted: true,
		})
		expect(offered.map((a) => a.name)).toEqual(['fine'])
		expect(refused).toHaveLength(1)
		expect(refused[0]?.line).toContain('/agents/guarded.md')
		expect(refused[0]?.line).toContain('PreToolUse group 1, hook 1')
		expect(refused[0]?.line).toContain('is not offered')
	})

	it('refuses a project file that carries a guard in a folder that is not trusted', () => {
		const { offered, refused } = vetAgentHooks([agent(GUARD, 'project')], { projectTrusted: false })
		expect(offered).toEqual([])
		expect(refused[0]?.line).toContain('not trusted')
	})

	it('offers a project file with no guard in it even when the folder is not trusted', () => {
		const stopOnly = agent(
			['hooks:', '  Notification:', '    - hooks:', '        - command: ./n.sh'].join('\n'),
			'project',
		)
		expect(vetAgentHooks([stopOnly], { projectTrusted: false }).offered).toHaveLength(1)
	})

	it('offers every file as if it had no hooks when a switch is on', () => {
		const { offered, refused } = vetAgentHooks([broken], {
			projectTrusted: true,
			hooksSwitch: 'disabled',
		})
		expect(offered).toHaveLength(1)
		expect(refused).toEqual([])
	})

	it('says it the same way each place it is said', () => {
		expect(refusalLine('a', '/x/a.md', 'why.')).toBe(
			'Agent "a" is not offered: /x/a.md, hooks: why. The agent is not started without the guard its file wrote; fix the entry or take it out of the file.',
		)
	})
})

describe('a run’s hooks', () => {
	it('fire for the run’s own session only, not the parent’s and not a sibling’s', async () => {
		const { mgr, h } = host()
		h.attachRun(agent(GUARD), RUN_A)
		expect(await preTool(mgr, RUN_A)).toEqual([expect.objectContaining({ action: 'skip' })])
		expect(await preTool(mgr, PARENT)).toEqual([expect.objectContaining({ action: 'continue' })])
		expect(await preTool(mgr, RUN_B)).toEqual([expect.objectContaining({ action: 'continue' })])
	})

	it('are kept apart for two runs of one agent at once, and each is taken off with its run', async () => {
		const { mgr, h } = host()
		const endA = h.attachRun(agent(GUARD), RUN_A)
		const endB = h.attachRun(agent(GUARD), RUN_B)
		expect(h.attached().map((row) => row.session)).toEqual([RUN_A, RUN_B])
		expect(await preTool(mgr, RUN_A)).toEqual([
			expect.objectContaining({ action: 'skip' }),
			expect.objectContaining({ action: 'continue' }),
		])
		endA()
		expect(h.attached().map((row) => row.session)).toEqual([RUN_B])
		expect(mgr.listHooks()).toHaveLength(1)
		expect(await preTool(mgr, RUN_A)).toEqual([expect.objectContaining({ action: 'continue' })])
		expect(await preTool(mgr, RUN_B)).toEqual([expect.objectContaining({ action: 'skip' })])
		endB()
		expect(mgr.listHooks()).toEqual([])
		endB()
	})

	it('are listed with the agent’s name while the run is alive', () => {
		const { h } = host()
		h.attachRun(agent(GUARD), RUN_A)
		expect(h.attached()).toEqual([
			{
				agent: 'guarded',
				event: 'pre_tool_use',
				runs: 'echo "no" >&2; exit 2',
				matcher: 'Bash',
				once: false,
				session: RUN_A,
			},
		])
	})

	it('fire the end-of-agent entry on subagent_stop with the last message, once', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'agent-hooks-'))
		const out = join(dir, 'seen.txt')
		const script = join(dir, 'stop.sh')
		writeFileSync(script, `#!/bin/sh\ncat >> ${out}\necho >> ${out}\nexit 0\n`, { mode: 0o755 })
		const { mgr, h } = host()
		h.attachRun(
			agent(
				[
					'hooks:',
					'  Stop:',
					'    - hooks:',
					`        - command: ${script}`,
					'  SubagentStop:',
					'    - hooks:',
					`        - command: ${script}`,
				].join('\n'),
			),
			RUN_A,
		)
		// The child's own turn_end does not run the entry: it is on subagent_stop.
		await mgr.executeHooks('turn_end', { sessionId: RUN_A, lastAssistantMessage: 'draft' })
		expect(() => readFileSync(out, 'utf8')).toThrow()
		await mgr.executeHooks('subagent_stop', {
			sessionId: RUN_A,
			parentSessionId: PARENT,
			agentType: 'guarded',
			lastAssistantMessage: 'the answer',
		})
		const lines = readFileSync(out, 'utf8').trim().split('\n')
		expect(lines).toHaveLength(1)
		const payload = JSON.parse(lines[0] as string)
		expect(payload.last_assistant_message).toBe('the answer')
		expect(payload.session_id).toBe(RUN_A)
	})

	it('keeps the agent working when the end-of-agent entry refuses', async () => {
		const { mgr, h } = host()
		h.attachRun(
			agent(
				[
					'hooks:',
					'  Stop:',
					'    - hooks:',
					'        - command: echo "check again" >&2; exit 2',
				].join('\n'),
			),
			RUN_A,
		)
		const [answer] = await mgr.executeHooks('subagent_stop', {
			sessionId: RUN_A,
			parentSessionId: PARENT,
			agentType: 'guarded',
			lastAssistantMessage: 'done',
		})
		expect(answer).toMatchObject({ action: 'skip', reason: expect.stringContaining('check again') })
	})

	it('is refused to start when its guard cannot be loaded', () => {
		const { h } = host()
		expect(() =>
			h.attachRun(
				agent(['hooks:', '  PreToolUse:', '    - hooks:', '        - type: nope'].join('\n')),
				RUN_A,
			),
		).toThrow(/is not offered.*agent|guarded\.md/)
	})

	it('is refused to start when it carries a guard and the session has no hook runtime', () => {
		const { h } = host({ noManager: true })
		expect(() => h.attachRun(agent(GUARD), RUN_A)).toThrow(/no hook runtime/)
	})

	it('are not attached when a switch is on, and the agent runs as if its file had none', async () => {
		const { mgr, h } = host({ hooksSwitch: 'disabled' })
		const end = h.attachRun(agent(GUARD), RUN_A)
		expect(mgr.listHooks()).toEqual([])
		end()
	})

	it('are not attached from a project file in a folder that is not trusted', () => {
		const { h } = host({ trusted: false })
		expect(() => h.attachRun(agent(GUARD, 'project'), RUN_A)).toThrow(/not trusted/)
	})

	it('say once when an entry was set aside', () => {
		const { h, lines } = host()
		const source = ['hooks:', '  SessionStart:', '    - hooks:', '        - command: ./x.sh'].join(
			'\n',
		)
		h.attachRun(agent(source), RUN_A)
		h.attachRun(agent(source), RUN_B)
		expect(lines).toHaveLength(1)
		expect(lines[0]).toContain('session_start')
	})

	it('stops a once entry after it has run', async () => {
		const { mgr, h } = host()
		h.attachRun(
			agent(
				[
					'hooks:',
					'  PreToolUse:',
					'    - hooks:',
					'        - command: "true"',
					'          once: true',
				].join('\n'),
			),
			RUN_A,
		)
		expect(mgr.listHooks()).toHaveLength(1)
		await preTool(mgr, RUN_A)
		expect(mgr.listHooks()).toHaveLength(0)
		expect(h.attached()).toEqual([])
	})
})
