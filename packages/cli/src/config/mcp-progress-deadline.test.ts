import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { approveProjectMcpServers } from '../integrations/mcp/project-approval.js'
import { parseMcpServerFile } from '../integrations/mcp/shared-file.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import { loadConfigWithProvenance } from './load.js'

const KEYS = { requestTimeoutMs: 5_000, resetTimeoutOnProgress: true, maxTotalTimeoutMs: 60_000 }

describe('progress-deadline keys on a configured server', () => {
	it('are read from the user config.yaml', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-pd-home-'))
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-pd-cwd-'))
		mkdirSync(join(home, '.namzu'), { recursive: true })
		writeFileSync(
			join(home, '.namzu', 'config.yaml'),
			[
				'mcpServers:',
				'  tickets:',
				'    command: node',
				'    requestTimeoutMs: 5000',
				'    resetTimeoutOnProgress: true',
				'    maxTotalTimeoutMs: 60000',
				'',
			].join('\n'),
		)
		const { config } = loadConfigWithProvenance({ home, cwd, env: {} })
		expect(config.mcpServers?.tickets).toEqual({ command: 'node', ...KEYS })
	})

	it('are read from namzu.config.json', () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-pd-home-'))
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-pd-cwd-'))
		writeFileSync(
			join(cwd, 'namzu.config.json'),
			JSON.stringify({ mcpServers: { tickets: { command: 'node', ...KEYS } } }),
		)
		const { config } = loadConfigWithProvenance({ home, cwd, env: {} })
		expect(config.mcpServers?.tickets).toEqual({ command: 'node', ...KEYS })
	})

	it('are read from .mcp.json', () => {
		const raw = JSON.stringify({
			mcpServers: { tickets: { type: 'stdio', command: 'node', ...KEYS } },
		})
		expect(parseMcpServerFile(raw, '.mcp.json').tickets).toEqual({ command: 'node', ...KEYS })

		const home = mkdtempSync(join(tmpdir(), 'namzu-pd-home-'))
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-pd-cwd-'))
		writeFileSync(join(cwd, '.mcp.json'), raw)
		approveProjectMcpServers(
			resolveNamzuHome({ home, env: {} }),
			cwd,
			parseMcpServerFile(raw, '.mcp.json'),
		)
		const { config } = loadConfigWithProvenance({ home, cwd, env: {} })
		expect(config.mcpServers?.tickets).toEqual({ command: 'node', ...KEYS })
	})
})
