/** Windows Pal computer setup from the terminal. */
import { COMPUTER_HELP, realComputerDeps, runComputerCommand } from '../computer/run.js'
import type { CommandDef } from './types.js'

export const computerCommand: CommandDef = {
	name: 'computer',
	description: 'Check and set up the computer Pals run on (Windows)',
	passThrough: true,
	help: COMPUTER_HELP,
	handler: async ({ rawArgs }) => {
		const controller = new AbortController()
		const abort = () => controller.abort()
		process.once('SIGINT', abort)
		try {
			return await runComputerCommand(rawArgs, realComputerDeps(controller.signal))
		} finally {
			process.off('SIGINT', abort)
		}
	},
}
