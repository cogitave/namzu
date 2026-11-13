import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'

import { resolve } from 'node:path'

import { hookSwitch, hooksBySource } from '../../config/hook-layers.js'
import { LOCAL_CONFIG_FILE, hookConfigProblems, shortHomePath } from '../../config/load.js'
import type { NamzuCliConfig } from '../../config/schema.js'
import { readSkillHooks, withoutSessionStart } from '../../config/skill-hooks-reader.js'
import { type AgentHooksCarrier, readAgentHooks } from '../../integrations/subagents/agent-hooks.js'
import { discoverAgentDefinitions } from '../../integrations/subagents/definitions.js'
import { isTrusted } from '../../integrations/trust/store.js'
import { type SkillInfo, discoverSkills } from '../../skills/store.js'
import {
	hookConfigProblemLines,
	hookReadingProblems,
	hooksSwitchLine,
} from '../../tui/slashCommands.js'

/**
 * How many hooks are attached, from which file, and whether a switch is
 * limiting them.
 *
 * A `pass` unless a matcher or `if` cannot be read, or a hook a file declared could not be loaded (then a `warn` names it): a
 * switch is something a person chose, and no hooks is a healthy state. The row exists so that "which of my hooks are running,
 * and from where" has an answer that does not need a conversation.
 */
export function describeHooksStatus(
	config: NamzuCliConfig,
	folder?: { readonly cwd: string; readonly trusted: boolean },
	skills: readonly SkillInfo[] = [],
	agents: readonly AgentHooksCarrier[] = [],
): DoctorCheckResult {
	const bySource = new Map(hooksBySource(config.hooks))
	// A project's files attach their hooks only once the folder is trusted; the
	// config this run read does not know that, so the row does not count them.
	let untrusted = 0
	if (folder && !folder.trusted) {
		for (const file of ['namzu.config.json', LOCAL_CONFIG_FILE]) {
			const label = shortHomePath(resolve(folder.cwd, file))
			untrusted += bySource.get(label) ?? 0
			bySource.delete(label)
		}
	}
	const total = [...bySource.values()].reduce((sum, count) => sum + count, 0)
	const state = hookSwitch(config)
	const lines: string[] = []
	if (total === 0) lines.push('No shell hooks are attached.')
	else {
		lines.push(
			`${total} shell ${total === 1 ? 'hook is' : 'hooks are'} attached: ${[...bySource]
				.map(([source, count]) => `${count} from ${source}`)
				.join(', ')}.`,
		)
	}
	if (untrusted > 0) {
		lines.push(
			`${untrusted} more ${untrusted === 1 ? 'is' : 'are'} declared in this folder's files and not attached, because the folder is not trusted.`,
		)
	}
	const unreadable: string[] = []
	for (const [event, entries] of Object.entries(config.hooks ?? {})) {
		for (const entry of entries ?? []) {
			if (entry.source !== undefined && !bySource.has(entry.source)) continue
			for (const problem of hookReadingProblems(entry)) unreadable.push(`${event}: ${problem}`)
		}
	}
	for (const each of unreadable) lines.push(`Cannot be read: ${each}.`)
	// What a file declared and this kernel could not load, or read but does not act on.
	const untrustedLabels =
		folder && !folder.trusted
			? new Set(
					['namzu.config.json', LOCAL_CONFIG_FILE].map((file) =>
						shortHomePath(resolve(folder.cwd, file)),
					),
				)
			: new Set<string>()
	const declared = hookConfigProblems().filter((problem) => !untrustedLabels.has(problem.file))
	for (const line of hookConfigProblemLines(declared)) lines.push(line)
	const notLoaded = declared.some((problem) => problem.severity === 'problem')
	// Skills attach their hooks when they are used: counted as carried, and
	// read now so one that could not be loaded is named before it is used.
	let skillWarn = false
	const carrying = skills.filter(
		(skill) =>
			skill.hooksSource !== undefined &&
			skill.problem === undefined &&
			!(skill.source === 'project' && folder && !folder.trusted),
	)
	if (carrying.length > 0) {
		lines.push(
			state === undefined
				? `${carrying.length} ${carrying.length === 1 ? 'skill carries' : 'skills carry'} hooks that attach when the skill is used: ${carrying.map((skill) => skill.name).join(', ')}.`
				: `${carrying.length} ${carrying.length === 1 ? 'skill carries' : 'skills carry'} hooks that do not attach, because a switch is on.`,
		)
		for (const skill of carrying) {
			const read = withoutSessionStart(
				readSkillHooks(skill.hooksSource as string, `skill ${skill.name}`),
			)
			for (const problem of read.problems) {
				if (problem.severity === 'problem') skillWarn = true
				lines.push(
					`${problem.severity === 'problem' ? 'Not loaded' : 'Note'}: skill ${skill.name}, ${problem.event}: ${problem.message}`,
				)
			}
			if (read.guardLost) {
				lines.push(
					read.count === 0
						? `Skill ${skill.name} loads without its hooks and without its allowed-tools pre-approval.`
						: `Skill ${skill.name} attaches the hooks that could be read and loads without its allowed-tools pre-approval.`,
				)
			}
		}
	}
	// Agent files attach theirs to each run of the agent. A file whose guard
	// cannot be loaded is not offered at all, and is named here.
	let agentWarn = false
	const carryingAgents = agents.filter(
		(agent) => !(agent.source === 'project' && folder && !folder.trusted),
	)
	if (carryingAgents.length > 0) {
		lines.push(
			state === undefined
				? `${carryingAgents.length} agent ${carryingAgents.length === 1 ? 'file carries' : 'files carry'} hooks that attach to each run of the agent: ${carryingAgents.map((agent) => agent.name).join(', ')}.`
				: `${carryingAgents.length} agent ${carryingAgents.length === 1 ? 'file carries' : 'files carry'} hooks that do not attach, because a switch is on.`,
		)
		for (const agent of carryingAgents) {
			const read = readAgentHooks(agent.hooksSource, agent.name)
			for (const problem of read.problems) {
				if (problem.severity === 'problem') agentWarn = true
				lines.push(
					`${problem.severity === 'problem' ? 'Not loaded' : 'Note'}: agent ${agent.name}, ${problem.event}: ${problem.message}`,
				)
			}
			if (read.guardLost && state === undefined) {
				lines.push(
					`Agent "${agent.name}" is not offered (${agent.path}); starting it is refused until the entry is fixed or taken out.`,
				)
			}
		}
	}
	lines.push(state === undefined ? 'No hook switch is on.' : `Switch on: ${hooksSwitchLine(state)}`)
	lines.push('Plugin hooks are not counted here; plugins have their own switch (plugins.enabled).')
	return {
		status: unreadable.length > 0 || notLoaded || skillWarn || agentWarn ? 'warn' : 'pass',
		message: lines.join(' '),
	}
}

export function hooksCheck(config: NamzuCliConfig): DoctorCheck {
	return {
		id: 'runtime.hooks',
		category: 'runtime',
		run: async (ctx) =>
			describeHooksStatus(
				config,
				{ cwd: ctx.cwd, trusted: isTrusted(ctx.cwd) },
				discoverSkills({ cwd: ctx.cwd, ...(config.skills ? { config: config.skills } : {}) }),
				await discoverAgentDefinitions({ cwd: ctx.cwd })
					.then((found) => found.carriers)
					.catch(() => []),
			),
	}
}
