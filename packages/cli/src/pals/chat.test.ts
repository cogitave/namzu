import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CommandContext } from '../commands/types.js'
import { EXIT_OK, EXIT_UNAVAILABLE, EXIT_USAGE } from '../exit-codes.js'
import { createFormatter } from '../output/index.js'
import { runPalChat } from './chat.js'

const controls = vi.hoisted(() => ({
	pal: { id: 'pal_fixture', workspace: '/private/pal-control', paused: false },
	start: vi.fn(),
	close: vi.fn(),
	launch: vi.fn(),
	claim: vi.fn(),
	binding: vi.fn(),
}))
vi.mock('./store.js', () => ({ getPal: () => controls.pal }))
vi.mock('./environment.js', () => ({
	getCliPalRuntime: async () => ({ startComputer: controls.start }),
	closeCliPalRuntime: controls.close,
}))
vi.mock('./conversations.js', () => ({
	newPalSessionId: () => 'ses_new',
	claimPalConversation: controls.claim,
	palConversationBinding: controls.binding,
}))
vi.mock('../tui/index.js', () => ({ launchTui: controls.launch }))

const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
let ctx: CommandContext
let error: ReturnType<typeof vi.spyOn>
beforeEach(() => {
	Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
	ctx = { config: {}, formatter: createFormatter('text', { quiet: false }) }
	error = vi.spyOn(ctx.formatter, 'error').mockImplementation(() => {})
	controls.start.mockReset().mockResolvedValue(undefined)
	controls.close.mockReset().mockResolvedValue(undefined)
	controls.launch.mockReset().mockResolvedValue(undefined)
	controls.claim.mockReset().mockResolvedValue(undefined)
	controls.binding.mockReset().mockResolvedValue({ pal: controls.pal })
})
afterEach(() => {
	if (tty) Object.defineProperty(process.stdout, 'isTTY', tty)
	else Reflect.deleteProperty(process.stdout, 'isTTY')
	vi.restoreAllMocks()
})

it('returns unavailable before opening the TUI or claiming history when its computer cannot start', async () => {
	controls.start.mockRejectedValue(new Error('Local computer engine unavailable'))
	expect(await runPalChat(ctx, controls.pal.id, [])).toBe(EXIT_UNAVAILABLE)
	expect(error).toHaveBeenCalledWith({ message: 'Local computer engine unavailable' })
	expect(controls.launch).not.toHaveBeenCalled()
	expect(controls.claim).not.toHaveBeenCalled()
	expect(controls.close).toHaveBeenCalledOnce()
})

it('validates resumed ownership before acquiring a computer', async () => {
	controls.binding.mockRejectedValue(new Error('Another Pal owns this conversation'))
	expect(await runPalChat(ctx, controls.pal.id, ['--resume', 'ses_foreign'])).toBe(EXIT_UNAVAILABLE)
	expect(controls.start).not.toHaveBeenCalled()
	expect(controls.launch).not.toHaveBeenCalled()
})

it('opens the existing TUI with a claimed Pal conversation and preserves the executable', async () => {
	const resumeCommand = ['/absolute/node', '--import', '/loader.mjs', '/checkout/bin.ts'] as const
	expect(await runPalChat(ctx, controls.pal.id, [], { resumeCommand })).toBe(EXIT_OK)
	expect(controls.start).toHaveBeenCalledWith(controls.pal.id)
	expect(controls.claim).toHaveBeenCalledWith(controls.pal.workspace, controls.pal.id, 'ses_new')
	expect(controls.launch).toHaveBeenCalledWith(
		expect.objectContaining({
			palId: controls.pal.id,
			cwd: controls.pal.workspace,
			initialConversationId: 'ses_new',
		}),
		{ resumeCommand },
	)
	expect(controls.close).toHaveBeenCalledOnce()
})

it('reports a failed computer shutdown without returning successful chat completion', async () => {
	controls.close.mockRejectedValue(new Error('Engine disconnected'))
	expect(await runPalChat(ctx, controls.pal.id, [])).toBe(EXIT_UNAVAILABLE)
	expect(error).toHaveBeenCalledWith({
		message: 'Could not stop the Pal computer: Engine disconnected',
	})
})

it('refuses malformed arguments without acquiring a computer', async () => {
	expect(await runPalChat(ctx, controls.pal.id, ['--resume'])).toBe(EXIT_USAGE)
	expect(controls.start).not.toHaveBeenCalled()
})
