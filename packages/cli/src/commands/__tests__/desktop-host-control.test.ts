import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { createPal } from '../../pals/store.js'
import type { CliAcpRuntime } from '../acp.js'
import { createDesktopHostExtensions } from '../desktop-host.js'

const calls = vi.hoisted(() => ({
	takeover: vi.fn(),
	release: vi.fn(),
	input: vi.fn(),
	screen: vi.fn(),
}))
vi.mock('../../pals/environment.js', () => ({
	cliPalComputerStatus: vi.fn(),
	startCliPalComputer: vi.fn(),
	stopCliPalComputer: vi.fn(),
	getCliPalRuntime: vi.fn(),
	takeOverCliPalComputer: calls.takeover,
	returnCliPalComputerControl: calls.release,
	executeCliPalComputerInput: calls.input,
	cliPalScreen: calls.screen,
}))
let root: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-pal-control-rpc-'))
	mkdirSync(join(root, 'home'))
	vi.stubEnv('NAMZU_HOME', join(root, 'home'))
	for (const call of Object.values(calls)) call.mockReset()
})
afterEach(() => {
	vi.unstubAllEnvs()
	removeTempDir(root)
})
function host(cwd: string) {
	return createDesktopHostExtensions({} as CliAcpRuntime, cwd)
}
it('binds all new control methods and screen generation to the exact trusted Pal client', async () => {
	const pal = createPal({ name: 'Owned RPC fixture' })
	const own = host(pal.workspace)
	const input = { type: 'type_text', text: 'owned input' }
	own['namzu/pals/computer/take_over']({ palId: pal.id, generation: '42' })
	own['namzu/pals/computer/return_control']({ palId: pal.id, generation: '42' })
	own['namzu/pals/computer/input']({ palId: pal.id, generation: '42', input })
	own['namzu/pals/computer/screen']({ palId: pal.id, generation: '42' })
	expect(calls.takeover).toHaveBeenCalledWith(pal.id, '42')
	expect(calls.release).toHaveBeenCalledWith(pal.id, '42')
	expect(calls.input).toHaveBeenCalledWith(pal.id, '42', input)
	expect(calls.screen).toHaveBeenCalledWith(pal.id, '42')
})
it('refuses a foreign or ordinary workspace before invoking a control adapter', () => {
	const pal = createPal({ name: 'Owned RPC fixture' })
	const foreign = createPal({ name: 'Foreign RPC fixture' })
	const ordinary = join(root, 'ordinary')
	mkdirSync(ordinary)
	const normal = host(ordinary)
	normal['namzu/project/trust']({ cwd: ordinary, confirmed: true })
	for (const owner of [host(foreign.workspace), normal]) {
		for (const method of [
			'namzu/pals/computer/take_over',
			'namzu/pals/computer/return_control',
			'namzu/pals/computer/input',
			'namzu/pals/computer/screen',
		] as const)
			expect(() =>
				owner[method]({ palId: pal.id, generation: '1', input: { type: 'key', keys: 'Return' } }),
			).toThrow('does not own')
	}
	for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled()
})
it('rejects a missing or nonstring generation before dispatching takeover, return or input', () => {
	const pal = createPal({ name: 'Owned RPC fixture' })
	const own = host(pal.workspace)
	for (const method of [
		'namzu/pals/computer/take_over',
		'namzu/pals/computer/return_control',
		'namzu/pals/computer/input',
	] as const)
		for (const generation of [undefined, 1, '', '1'.repeat(17)])
			expect(() =>
				own[method]({ palId: pal.id, generation, input: { type: 'key', keys: 'Return' } }),
			).toThrow('generation')
	for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled()
})
