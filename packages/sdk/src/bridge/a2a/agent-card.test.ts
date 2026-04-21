/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 2):
 *
 *   - `buildAgentCard(info, config, skills?)`:
 *     - `name`, `description`, `version` are passed through from info.
 *     - `protocolVersion` is pinned to `A2A_PROTOCOL_VERSION` (0.3.0).
 *     - `provider.organization` defaults to 'Namzu' when
 *       `config.providerOrganization` is absent.
 *     - `capabilities.streaming` mirrors
 *       `info.capabilities?.supportsStreaming` with false default;
 *       `pushNotifications` + `extendedAgentCard` are always false.
 *     - Each tool in `info.tools` becomes a skill with
 *       `{id: 'tool-<name>', name: '<name>', tags: ['tool']}`.
 *     - Each entry in the optional `skills` param becomes a skill with
 *       `tags: ['procedure']` and id = name = skill.metadata.name.
 *     - Tool skills come first, procedural skills after, in insertion
 *       order.
 *     - `supportedInterfaces[0].url` = `${config.baseUrl}/a2a/${info.id}`.
 *     - `securitySchemes` always includes `bearer` + `securityRequirements`
 *       is `[{bearer: []}]`.
 *     - `defaultInputModes` and `defaultOutputModes` are `['text']`.
 */

import { describe, expect, it } from 'vitest'

import type { AgentInfo } from '../../contracts/index.js'
import type { A2AServerConfig } from '../../types/a2a/index.js'
import type { Skill } from '../../types/skills/index.js'

import { buildAgentCard } from './agent-card.js'

const baseInfo: AgentInfo = {
	id: 'coder',
	name: 'Coder',
	version: '1.0.0',
	category: 'coding',
	description: 'Writes code',
	tools: ['read_file', 'write_file'],
	defaults: { model: 'claude-opus-4-7', tokenBudget: 100_000 },
}

const baseConfig: A2AServerConfig = {
	baseUrl: 'https://example.com',
	transport: 'jsonrpc',
}

describe('buildAgentCard', () => {
	it('passes name / description / version through', () => {
		const card = buildAgentCard(baseInfo, baseConfig)
		expect(card.name).toBe('Coder')
		expect(card.description).toBe('Writes code')
		expect(card.version).toBe('1.0.0')
	})

	it('pins protocolVersion to A2A_PROTOCOL_VERSION', () => {
		const card = buildAgentCard(baseInfo, baseConfig)
		expect(card.protocolVersion).toBe('0.3.0')
	})

	it('defaults provider.organization to Namzu when config omits it', () => {
		const card = buildAgentCard(baseInfo, baseConfig)
		expect(card.provider?.organization).toBe('Namzu')
		expect(card.provider?.url).toBeUndefined()
	})

	it('uses config-supplied providerOrganization + providerUrl when given', () => {
		const card = buildAgentCard(baseInfo, {
			...baseConfig,
			providerOrganization: 'ACME',
			providerUrl: 'https://acme.io',
		})
		expect(card.provider?.organization).toBe('ACME')
		expect(card.provider?.url).toBe('https://acme.io')
	})

	it('streaming capability mirrors info.capabilities?.supportsStreaming (default false)', () => {
		const noCaps = buildAgentCard(baseInfo, baseConfig)
		expect(noCaps.capabilities.streaming).toBe(false)

		const withStreaming = buildAgentCard(
			{
				...baseInfo,
				capabilities: {
					supportsTools: true,
					supportsStreaming: true,
					supportsConcurrency: false,
					supportsSubAgents: false,
				},
			},
			baseConfig,
		)
		expect(withStreaming.capabilities.streaming).toBe(true)
	})

	it('pushNotifications + extendedAgentCard are always false', () => {
		const card = buildAgentCard(baseInfo, baseConfig)
		expect(card.capabilities.pushNotifications).toBe(false)
		expect(card.capabilities.extendedAgentCard).toBe(false)
	})

	it('each tool becomes a skill with id = tool-<name> + tags = [tool]', () => {
		const card = buildAgentCard(baseInfo, baseConfig)
		const toolSkills = card.skills.filter((s) => s.tags?.includes('tool'))
		expect(toolSkills.map((s) => s.id)).toEqual(['tool-read_file', 'tool-write_file'])
		expect(toolSkills.map((s) => s.name)).toEqual(['read_file', 'write_file'])
	})

	it('procedural skills come after tool skills with tags = [procedure]', () => {
		const skills: Skill[] = [
			{
				metadata: { name: 'commit', description: 'Drafts commits' },
				dirPath: '/skills/commit',
			},
		]
		const card = buildAgentCard(baseInfo, baseConfig, skills)
		expect(card.skills).toHaveLength(3)
		const last = card.skills[2]
		expect(last?.id).toBe('commit')
		expect(last?.name).toBe('commit')
		expect(last?.tags).toEqual(['procedure'])
	})

	it('supportedInterfaces[0].url = <baseUrl>/a2a/<id>', () => {
		const card = buildAgentCard(baseInfo, baseConfig)
		expect(card.supportedInterfaces[0]?.url).toBe('https://example.com/a2a/coder')
		expect(card.supportedInterfaces[0]?.transport).toBe('jsonrpc')
	})

	it('carries bearer security scheme + requirement by default', () => {
		const card = buildAgentCard(baseInfo, baseConfig)
		expect(card.securitySchemes?.bearer).toMatchObject({ type: 'http', scheme: 'bearer' })
		expect(card.securityRequirements).toEqual([{ bearer: [] }])
	})

	it('default input / output modes are text-only', () => {
		const card = buildAgentCard(baseInfo, baseConfig)
		expect(card.defaultInputModes).toEqual(['text'])
		expect(card.defaultOutputModes).toEqual(['text'])
	})
})
