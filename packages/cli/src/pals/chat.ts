/** Launch the existing terminal application with a durable Pal-owned conversation. */
import type { CommandContext } from '../commands/types.js'
import { EXIT_OK, EXIT_UNAVAILABLE, EXIT_USAGE } from '../exit-codes.js'
import { compilePermissions } from '../permissions/rules.js'
import type { TuiContext } from '../tui/types.js'
import { CLI_VERSION } from '../version.js'
import { claimPalConversation, newPalSessionId, palConversationBinding } from './conversations.js'
import { closeCliPalRuntime, getCliPalRuntime } from './environment.js'
import { getPal } from './store.js'

export async function runPalChat(
	ctx: CommandContext,
	palId: string,
	args: readonly string[],
	options: {
		readonly resumeCommand?: readonly [string, ...string[]]
	} = {},
): Promise<number> {
	if (args.length !== 0 && (args.length !== 2 || args[0] !== '--resume' || !args[1])) {
		ctx.formatter.error({ message: 'Usage: namzu pal chat <id> [--resume <conversation-id>]' })
		return EXIT_USAGE
	}
	if (!process.stdout.isTTY) {
		ctx.formatter.error({ message: 'Pal chat requires an interactive terminal.' })
		return EXIT_UNAVAILABLE
	}
	let code: number = EXIT_OK
	try {
		const pal = getPal(palId)
		if (!pal) throw new Error('Pal does not exist.')
		if (pal.paused) throw new Error('This Pal is paused. Resume it before opening chat.')
		const conversationId = args[1] ?? newPalSessionId()
		if (args[1]) {
			const binding = await palConversationBinding(pal.workspace, conversationId)
			if (!binding || binding.pal.id !== palId)
				throw new Error('This conversation is not owned by this Pal.')
		}
		const runtime = await getCliPalRuntime()
		await runtime.startComputer(palId)
		if (!args[1]) {
			await claimPalConversation(pal.workspace, palId, conversationId)
		}
		const permissions = compilePermissions(ctx.config.permissions, ctx.config.permissionChecks)
		for (const diagnostic of permissions.diagnostics)
			ctx.formatter.error({ message: diagnostic.message })
		const tui: TuiContext = {
			cwd: pal.workspace,
			version: CLI_VERSION,
			palId,
			initialConversationId: conversationId,
			rules: permissions.rules,
			...(ctx.logging ? { logging: ctx.logging } : {}),
			...(ctx.config.limits ? { limits: ctx.config.limits } : {}),
			...(ctx.config.tui ? { tui: ctx.config.tui } : {}),
			...(ctx.config.composerTriggers ? { composerTriggers: ctx.config.composerTriggers } : {}),
		}
		const { launchTui } = await import('../tui/index.js')
		await launchTui(tui, options)
	} catch (error) {
		ctx.formatter.error({ message: error instanceof Error ? error.message : String(error) })
		code = EXIT_UNAVAILABLE
	} finally {
		try {
			await closeCliPalRuntime()
		} catch (error) {
			ctx.formatter.error({
				message: `Could not stop the Pal computer: ${error instanceof Error ? error.message : String(error)}`,
			})
			code = EXIT_UNAVAILABLE
		}
	}
	return code
}
