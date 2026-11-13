import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginLifecycleManager, type SessionId } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { createSkillHooksHost, skillHookEnv } from './skill-hooks.js'

/**
 * A skill's hooks are attached when the skill is used and end with the
 * conversation; a forked skill's belong to the delegated agent's run. These
 * run real commands under `sh`, so a test that waits for one has Vitest's own
 * per-test timeout as its only clock: nothing here races real time.
 */

const PARENT = '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as SessionId
const CHILD = '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5c' as SessionId
const OTHER = '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5d' as SessionId

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

interface Setup {
	readonly hooksSwitch?: 'disabled' | 'managed-only'
	readonly trusted?: boolean
	readonly project?: boolean
	readonly noManager?: boolean
}

function host(setup: Setup = {}) {
	const mgr = manager()
	const lines: string[] = []
	const h = createSkillHooksHost({
		manager: () => (setup.noManager ? undefined : mgr),
		hookOptions: () => ({ cwd: process.cwd() }),
		hooksSwitch: () => setup.hooksSwitch,
		projectTrusted: () => setup.trusted ?? true,
		isProjectSkill: () => setup.project ?? false,
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

const skill = (hooksSource: string, name = 'guarded') => ({
	name,
	dirPath: '/skills/guarded',
	hooksSource,
})

async function preTool(
	mgr: PluginLifecycleManager,
	sessionId: SessionId = PARENT,
	toolName = 'bash',
) {
	return mgr.executeHooks('pre_tool_use', { sessionId, toolName, toolInput: { command: 'ls' } })
}

describe('an inline skill’s hooks', () => {
	it('attach when the skill is used, not when it is read, and refuse the call', async () => {
		const { mgr, h } = host()
		const plan = h.prepareHooks(skill(GUARD), { forked: false })
		expect(mgr.listHooks()).toEqual([])
		expect(await preTool(mgr)).toEqual([])
		plan.attach()
		expect(mgr.listHooks()).toHaveLength(1)
		const [answer] = await preTool(mgr)
		expect(answer).toMatchObject({ action: 'skip' })
		expect(plan.withholdGrants).toBe(false)
		expect(plan.notice).toContain('were attached to this conversation when it was loaded')
		expect(plan.notice).toContain('same message')
	})

	it('are listed with the skill’s name for /hooks', () => {
		const { h } = host()
		h.prepareHooks(skill(GUARD), { forked: false }).attach()
		expect(h.attached()).toEqual([
			{
				skill: 'guarded',
				event: 'pre_tool_use',
				runs: 'echo "no" >&2; exit 2',
				matcher: 'Bash',
				once: false,
				scope: 'conversation',
			},
		])
	})

	it('are not attached twice when the skill is used again', () => {
		const { mgr, h } = host()
		h.prepareHooks(skill(GUARD), { forked: false }).attach()
		h.prepareHooks(skill(GUARD), { forked: false }).attach()
		h.use(skill(GUARD))
		expect(mgr.listHooks()).toHaveLength(1)
		expect(h.attached()).toHaveLength(1)
	})

	it('are replaced, not doubled, when the skill was edited and is used again', () => {
		const { mgr, h } = host()
		h.use(skill(GUARD))
		h.use(skill(`${GUARD}\n    - matcher: Edit\n      hooks:\n        - command: "exit 2"`))
		expect(mgr.listHooks()).toHaveLength(2)
		expect(h.attached().map((hook) => hook.runs)).toEqual(['echo "no" >&2; exit 2', 'exit 2'])
	})

	it('end with the conversation: clearing, replacing or leaving takes them off', async () => {
		const { mgr, h } = host()
		h.use(skill(GUARD))
		h.endConversation()
		expect(mgr.listHooks()).toEqual([])
		expect(h.attached()).toEqual([])
		expect(await preTool(mgr)).toEqual([])
		// The conversation that follows starts without them, and can attach them again.
		h.use(skill(GUARD))
		expect(mgr.listHooks()).toHaveLength(1)
	})

	it('with once: true are taken off after the first successful run', async () => {
		const { mgr, h } = host()
		h.use(
			skill(['hooks:', '  PreToolUse:', '    - command: "exit 0"', '      once: true'].join('\n')),
		)
		expect(h.attached()[0]).toMatchObject({ once: true })
		await preTool(mgr)
		expect(mgr.listHooks()).toEqual([])
		expect(h.attached()).toEqual([])
	})

	it('with once: true stay attached while no call has selected them', async () => {
		const { mgr, h } = host()
		h.use(
			skill(
				[
					'hooks:',
					'  PreToolUse:',
					'    - command: "exit 0"',
					'      matcher: edit',
					'      once: true',
				].join('\n'),
			),
		)
		await preTool(mgr, PARENT, 'bash')
		expect(mgr.listHooks()).toHaveLength(1)
		await preTool(mgr, PARENT, 'edit')
		expect(mgr.listHooks()).toEqual([])
	})

	it('give the command the skill’s folder, as a variable and as a substitution', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'skill-hooks-'))
		const { mgr, h } = host()
		h.prepareHooks(
			{
				name: 'rooted',
				dirPath: dir,
				hooksSource: [
					'hooks:',
					'  UserPromptSubmit:',
					'    - hooks:',
					'        - command: sh',
					`          args: ["-c", "printf %s \\"$NAMZU_SKILL_ROOT|\${NAMZU_SKILL_ROOT}\\" > ${dir}/out"]`,
				].join('\n'),
			},
			{ forked: false },
		).attach()
		await mgr.executeHooks('user_prompt_submit', { sessionId: PARENT, prompt: 'hi' })
		expect(readFileSync(join(dir, 'out'), 'utf8')).toBe(`${dir}|${dir}`)
		expect(skillHookEnv('/x')).toEqual({ NAMZU_SKILL_ROOT: '/x' })
	})

	it('give a variable written for another tool the skill’s folder and the project folder, and not a data folder', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'skill-hooks-'))
		const project = mkdtempSync(join(tmpdir(), 'skill-project-'))
		const mgr = manager()
		const h = createSkillHooksHost({
			manager: () => mgr,
			hookOptions: () => ({ cwd: project, projectDir: project }),
			hooksSwitch: () => undefined,
			projectTrusted: () => true,
			isProjectSkill: () => false,
		})
		writeFileSync(join(dir, 'put.sh'), 'printf %s "$1|$2|[$3]" > "$4"\n')
		h.prepareHooks(
			{
				name: 'moved',
				dirPath: dir,
				hooksSource: [
					'hooks:',
					'  UserPromptSubmit:',
					'    - hooks:',
					'        - command: sh',
					'          args: ["${ACME_PLUGIN_ROOT}/put.sh", "$ACME_PROJECT_DIR", "$ACME_PLUGIN_ROOT", "$ACME_PLUGIN_DATA", "' +
						join(dir, 'out') +
						'"]',
					'    - hooks:',
					'        - command: \'sh "$ACME_PLUGIN_ROOT/put.sh" "$ACME_SKILL_ROOT" "$ACME_PROJECT_DIR" "$ACME_PLUGIN_DATA" ' +
						join(dir, 'out2') +
						"'",
				].join('\n'),
			},
			{ forked: false },
		).attach()
		await mgr.executeHooks('user_prompt_submit', { sessionId: PARENT, prompt: 'hi' })
		expect(readFileSync(join(dir, 'out'), 'utf8')).toBe(`${project}|${dir}|[$ACME_PLUGIN_DATA]`)
		expect(readFileSync(join(dir, 'out2'), 'utf8')).toBe(`${dir}|${project}|[]`)
	})

	it('are made with the skill’s name as their source', () => {
		const { h } = host()
		h.use(skill(GUARD))
		expect(h.attached()[0]?.skill).toBe('guarded')
	})
})

describe('a skill whose guard cannot be loaded', () => {
	const BROKEN = ['hooks:', '  PreToolUse:', '    - hooks:', '        - args: ["a"]'].join('\n')

	it('loads with none of its hooks and none of its pre-approval, and both sides are told once', () => {
		const { mgr, h, lines } = host()
		const plan = h.prepareHooks(skill(BROKEN), { forked: false })
		const again = h.prepareHooks(skill(BROKEN), { forked: false })
		plan.attach()
		expect(plan.withholdGrants).toBe(true)
		expect(plan.notice).toContain('Skill guarded:')
		expect(plan.notice).toContain('allowed-tools are not pre-approved')
		expect(again.withholdGrants).toBe(true)
		expect(mgr.listHooks()).toEqual([])
		expect(lines).toEqual([plan.notice])
	})

	it('attaches the entries that could be read, beside the one that could not, and withholds the pre-approval', () => {
		const { mgr, h, lines } = host()
		const plan = h.prepareHooks(skill(`${BROKEN}\n    - hooks:\n        - command: "exit 0"`), {
			forked: false,
		})
		plan.attach()
		expect(plan.withholdGrants).toBe(true)
		expect(mgr.listHooks()).toHaveLength(1)
		expect(plan.notice).toContain('Not loaded:')
		expect(plan.notice).toContain('allowed-tools are not pre-approved')
		expect(lines.join('\n')).toContain('Not loaded:')
	})

	it('keeps a readable guard when an entry on another guarding event cannot be read', async () => {
		const { mgr, h } = host()
		const plan = h.prepareHooks(
			skill(`${GUARD}\n  PostToolUse:\n    - hooks:\n        - type: nope`),
			{ forked: false },
		)
		plan.attach()
		expect(plan.withholdGrants).toBe(true)
		expect((await preTool(mgr)).filter((r) => r.action === 'skip')).toHaveLength(1)
	})

	it('keeps the pre-approval when only a quiet event’s entry was set aside, and says what was set aside', () => {
		const { mgr, h, lines } = host()
		const plan = h.prepareHooks(
			skill(
				[
					'hooks:',
					'  SessionStart:',
					'    - hooks:',
					'        - args: ["a"]',
					'  PreToolUse:',
					'    - hooks:',
					'        - command: "exit 0"',
				].join('\n'),
			),
			{ forked: false },
		)
		plan.attach()
		expect(plan.withholdGrants).toBe(false)
		expect(mgr.listHooks()).toHaveLength(1)
		expect(plan.notice).toContain('Set aside')
		expect(lines).toHaveLength(1)
	})

	it('withholds the pre-approval when there is no hook runtime to attach to', () => {
		const { h } = host({ noManager: true })
		const plan = h.prepareHooks(skill(GUARD), { forked: false })
		expect(plan.withholdGrants).toBe(true)
		expect(plan.notice).toContain('no hook runtime')
	})
})

describe('a skill’s session_start entry', () => {
	it('is set aside with a note and is not listed as attached: it cannot fire for a skill used mid-conversation', () => {
		const { mgr, h, lines } = host()
		const plan = h.prepareHooks(
			skill(`${GUARD}\n  SessionStart:\n    - hooks:\n        - command: "exit 0"`),
			{ forked: false },
		)
		plan.attach()
		expect(mgr.listHooks()).toHaveLength(1)
		expect(h.attached().map((hook) => hook.event)).toEqual(['pre_tool_use'])
		expect(plan.withholdGrants).toBe(false)
		expect(plan.notice).toContain('session_start')
		expect(lines.join('\n')).toContain('session_start')
	})
})

describe('the switches', () => {
	it.each(['disabled', 'managed-only'] as const)(
		'%s: the skill loads as if it had no hooks key, grants stay, nothing attaches',
		(hooksSwitch) => {
			const { mgr, h, lines } = host({ hooksSwitch })
			const plan = h.prepareHooks(skill(GUARD), { forked: false })
			plan.attach()
			h.use(skill(GUARD))
			expect(plan.withholdGrants).toBe(false)
			expect(plan.notice).toBeUndefined()
			expect(mgr.listHooks()).toEqual([])
			expect(lines).toEqual([])
		},
	)
})

describe('a skill in the folder', () => {
	it('attaches nothing while the folder is not trusted, and withholds the pre-approval', () => {
		const { mgr, h } = host({ project: true, trusted: false })
		const plan = h.prepareHooks(skill(GUARD), { forked: false })
		plan.attach()
		h.use(skill(GUARD))
		expect(plan.withholdGrants).toBe(true)
		expect(plan.notice).toContain('not trusted')
		expect(mgr.listHooks()).toEqual([])
	})

	it('attaches once the folder is trusted', () => {
		const { mgr, h } = host({ project: true, trusted: true })
		h.use(skill(GUARD))
		expect(mgr.listHooks()).toHaveLength(1)
	})

	it('is the only kind the trust decision stops: a skill of the person’s own attaches in an untrusted folder', () => {
		const { mgr, h } = host({ project: false, trusted: false })
		h.use(skill(GUARD))
		expect(mgr.listHooks()).toHaveLength(1)
	})
})

describe('a forked skill’s hooks', () => {
	async function start(mgr: PluginLifecycleManager, child = CHILD, parent: SessionId = PARENT) {
		await mgr.executeHooks('subagent_start', {
			sessionId: child,
			parentSessionId: parent,
			agentType: 'explore',
		})
	}

	it('cover no session until the delegated agent starts, then only that agent', async () => {
		const { mgr, h } = host()
		h.prepareHooks(skill(GUARD), { forked: true, sessionId: PARENT }).attach()
		expect((await preTool(mgr, PARENT)).filter((r) => r.action === 'skip')).toEqual([])
		await start(mgr)
		expect((await preTool(mgr, CHILD)).filter((r) => r.action === 'skip')).toHaveLength(1)
		// The caller's own calls, and another agent's, are not covered.
		expect((await preTool(mgr, PARENT)).filter((r) => r.action === 'skip')).toEqual([])
		expect((await preTool(mgr, OTHER)).filter((r) => r.action === 'skip')).toEqual([])
	})

	it('cover the agent the skill delegated to, not another that started first', async () => {
		const { mgr, h } = host()
		h.prepareHooks(skill(GUARD), {
			forked: true,
			sessionId: PARENT,
			prompt: 'Run the skill steps.',
		}).attach()
		// Two agents start under the same session; the other one is not the skill's.
		await start(mgr, OTHER)
		await start(mgr, CHILD)
		await mgr.executeHooks('user_prompt_submit', { sessionId: OTHER, prompt: 'Another task' })
		await mgr.executeHooks('user_prompt_submit', {
			sessionId: CHILD,
			prompt: 'Run the skill steps.',
		})
		expect((await preTool(mgr, CHILD)).filter((r) => r.action === 'skip')).toHaveLength(1)
		expect((await preTool(mgr, OTHER)).filter((r) => r.action === 'skip')).toEqual([])
	})

	it('cover the skill’s agent when it started first and another one started after', async () => {
		const { mgr, h } = host()
		h.prepareHooks(skill(GUARD), { forked: true, sessionId: PARENT, prompt: 'The steps' }).attach()
		await start(mgr, CHILD)
		await start(mgr, OTHER)
		await mgr.executeHooks('user_prompt_submit', { sessionId: CHILD, prompt: 'The steps' })
		await mgr.executeHooks('user_prompt_submit', { sessionId: OTHER, prompt: 'Something else' })
		expect((await preTool(mgr, CHILD)).filter((r) => r.action === 'skip')).toHaveLength(1)
		expect((await preTool(mgr, OTHER)).filter((r) => r.action === 'skip')).toEqual([])
	})

	it('cover an agent the delegated agent starts', async () => {
		const { mgr, h } = host()
		h.prepareHooks(skill(GUARD), { forked: true, sessionId: PARENT }).attach()
		await start(mgr)
		await start(mgr, OTHER, CHILD)
		expect((await preTool(mgr, OTHER)).filter((r) => r.action === 'skip')).toHaveLength(1)
	})

	it('end when the agent ends', async () => {
		const { mgr, h } = host()
		h.prepareHooks(skill(GUARD), { forked: true, sessionId: PARENT }).attach()
		await start(mgr)
		await mgr.executeHooks('subagent_stop', {
			sessionId: CHILD,
			parentSessionId: PARENT,
			agentType: 'explore',
		})
		// The removal is queued behind the event that ended the agent.
		await Promise.resolve()
		expect(mgr.listHooks()).toEqual([])
		expect(h.attached()).toEqual([])
	})

	it('end when the handle is removed, and with the conversation', () => {
		const { mgr, h } = host()
		const handle = h.prepareHooks(skill(GUARD), { forked: true, sessionId: PARENT }).attach()
		expect(h.attached()[0]).toMatchObject({ scope: 'agent' })
		handle.remove()
		expect(mgr.listHooks()).toEqual([])
		h.prepareHooks(skill(GUARD), { forked: true, sessionId: PARENT }).attach()
		h.endConversation()
		expect(mgr.listHooks()).toEqual([])
	})

	it('do not wait for the session that used the skill to be named: the first agent to start is covered', async () => {
		const { mgr, h } = host()
		h.prepareHooks(skill(GUARD), { forked: true }).attach()
		await start(mgr)
		expect((await preTool(mgr, CHILD)).filter((r) => r.action === 'skip')).toHaveLength(1)
	})

	it('are not attached twice when the skill is used again while its agent runs: each use is its own agent', () => {
		const { mgr, h } = host()
		h.prepareHooks(skill(GUARD), { forked: true, sessionId: PARENT }).attach()
		h.prepareHooks(skill(GUARD), { forked: true, sessionId: PARENT }).attach()
		// Two uses, two agents, two scoped sets (plus the two binders each).
		expect(mgr.listHooks()).toHaveLength(6)
	})
})
