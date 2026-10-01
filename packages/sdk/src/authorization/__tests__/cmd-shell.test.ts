import { describe, expect, it } from 'vitest'
import { BashTool } from '../../tools/builtins/bash.js'
import type { AuthorizationGateConfig } from '../../types/authorization/index.js'
import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import { decomposeCommandLine, writesThroughRedirection } from '../command-line.js'
import { AuthorizationGate } from '../gate.js'
import { unknownProgramInLine } from '../program.js'
import { lexShellCommandLine } from '../shell-lexer.js'
import { SkillGrantSet, compileSkillGrant, parseAllowedTools } from '../skill-grant.js'

const mismatch = "echo 'safe & echo SECOND_COMMAND & echo '"
function gate(wholeTool = false) {
	return new AuthorizationGate(
		{
			enabled: true,
			allowReadOnlyTools: false,
			denyDangerousPatterns: false,
			logDecisions: false,
			rules: wholeTool
				? [{ type: 'allow_by_name', toolNames: ['bash'] }]
				: [
						{
							type: 'argument_pattern',
							toolNames: ['bash'],
							argument: 'command',
							pattern: '^echo',
							decision: 'allow',
						},
					],
		} as AuthorizationGateConfig,
		NOOP_LOGGER,
	)
}
describe('native CMD commands are never inferred from a POSIX reading', () => {
	it.each([mismatch, 'echo %COMMAND%', 'echo safe ^& hidden', 'echo hello', 'dir > output.txt'])(
		'treats %s as opaque without inventing commands',
		(line) => {
			expect(lexShellCommandLine(line, { dialect: 'cmd' })).toMatchObject({
				commands: [],
				opaque: true,
				complete: false,
			})
			expect(decomposeCommandLine(line, 'cmd')).toEqual({ segments: [line], opaque: true })
			expect(writesThroughRedirection(line, 'cmd')).toBe(true)
			expect(unknownProgramInLine(line, 'cmd')).toContain('native CMD')
		},
	)
	it('withdraws a command-specific allow that the old sh reading incorrectly granted', () => {
		const call = { toolName: 'bash', toolInput: { command: mismatch }, toolDef: BashTool }
		expect(gate().evaluate({ ...call, commandDialect: 'sh' }).decision).toBe('allow')
		expect(gate().evaluate({ ...call, commandDialect: 'cmd' }).decision).not.toBe('allow')
		expect(gate(true).evaluate({ ...call, commandDialect: 'cmd' }).decision).toBe('allow')
	})
	it('declines pattern skill grants while retaining an explicit whole-tool grant at the gate', () => {
		const resolveTool = (name: string) =>
			name.toLowerCase() === 'bash' ? { name: 'bash', commandArgument: 'command' } : undefined
		const grants = new SkillGrantSet()
		grants.grant(
			'pattern',
			compileSkillGrant(parseAllowedTools('Bash(echo *)') ?? [], { resolveTool }),
		)
		expect(
			grants.coveringSkill({ name: 'bash', input: { command: mismatch } }, BashTool, {
				commandDialect: 'cmd',
			}),
		).toBeUndefined()
		grants.grant('whole', compileSkillGrant(parseAllowedTools('Bash') ?? [], { resolveTool }))
		expect(
			grants.coveringSkill({ name: 'bash', input: { command: mismatch } }, BashTool, {
				commandDialect: 'cmd',
			}),
		).toBe('whole')
	})
})
