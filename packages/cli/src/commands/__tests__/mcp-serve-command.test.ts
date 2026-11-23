import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { NamzuCliConfig } from '../../config/schema.js'
import { runMcpServe } from '../mcp-serve.js'
import type { CommandContext } from '../types.js'

const roots: string[] = []
afterEach(() => {
	vi.unstubAllEnvs()
	for (const root of roots.splice(0)) removeTempDir(root)
})

function setup() {
	const home = mkdtempSync(join(tmpdir(), 'namzu-mcp-serve-home-'))
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-mcp-serve-cwd-'))
	roots.push(home, cwd)
	vi.stubEnv('NAMZU_HOME', home)
	writeFileSync(join(cwd, 'note.txt'), 'read through the launch\n')
	const errors: string[] = []
	const ctx = {
		formatter: {
			name: 'text',
			print: () => {},
			info: () => {},
			error: ({ message }: { message: string }) => errors.push(message),
		},
		config: {} as NamzuCliConfig,
	} as unknown as CommandContext
	return { cwd, ctx, errors }
}

it('refuses a bad flag, an unknown mode and an untrusted folder before serving anything', async () => {
	const { cwd, ctx, errors } = setup()
	const run = (args: string[]) =>
		runMcpServe({ args, ctx, input: new PassThrough(), output: new PassThrough(), cwd })
	expect(await run(['--nope'])).toBe(64)
	expect(await run(['--permission-mode', 'sideways'])).toBe(64)
	expect(await run(['--allowed-tools', 'read('])).toBe(64)
	expect(await run(['--add-dir'])).toBe(64)
	expect(errors).toHaveLength(4)
	// nobody trusts this folder in the scratch home, and no flag says to
	expect(await run([])).toBe(77)
})

it('serves the launch flags it was given: a read allowed by --allowed-tools runs', async () => {
	const { cwd, ctx } = setup()
	const input = new PassThrough()
	const output = new PassThrough()
	output.setEncoding('utf8')
	const served = runMcpServe({
		args: ['--trust', '--allowed-tools', 'read', '--disallowed-tools', 'bash'],
		ctx,
		input,
		output,
		cwd,
	})
	const answers = new Promise<string[]>((resolve) => {
		let text = ''
		output.on('data', (chunk: string) => {
			text += chunk
			const lines = text.split('\n').filter(Boolean)
			if (lines.length === 2) resolve(lines)
		})
	})
	input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`)
	input.write(
		`${JSON.stringify({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: { name: 'read', arguments: { path: join(cwd, 'note.txt') } },
		})}\n`,
	)
	const [listed, read] = (await answers).map((line) => JSON.parse(line))
	// a tool a deny rule refuses by name is not offered
	expect(listed.result.tools.map((tool: { name: string }) => tool.name)).not.toContain('bash')
	expect(read.result.content[0].text).toContain('read through the launch')
	input.end()
	expect(await served).toBe(0)
})
