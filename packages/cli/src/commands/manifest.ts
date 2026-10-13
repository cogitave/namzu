import { type LazyCommandDef, lazyCommand } from './lazy.js'
import type { createWorktreeCommand } from './worktree.js'

/**
 * The commands `namzu` registers, as definitions that do not import their
 * handlers. The name, aliases, description and `passThrough` here are what
 * `namzu --help` prints; `commands/__tests__/manifest.test.ts` loads each real
 * definition and fails when one of these has drifted from it.
 */

export const acpCommand = lazyCommand(
	{
		name: 'acp',
		description: 'Speak the agent-client protocol over this process’s stdio',
		passThrough: true,
	},
	async () => (await import('./acp.js')).acpCommand,
)

export const computerCommand = lazyCommand(
	{
		name: 'computer',
		description: 'Check and set up the computer Pals run on (Windows)',
		passThrough: true,
	},
	async () => (await import('./computer.js')).computerCommand,
)

export const archiveCommand = lazyCommand(
	{
		name: 'archive',
		description: 'List or restore archived conversations in this project',
		passThrough: true,
	},
	async () => (await import('./archive.js')).archiveCommand,
)

export const doctorCommand = lazyCommand(
	{
		name: 'doctor',
		description: 'Run health checks against the local Namzu environment',
		passThrough: true,
	},
	async () => (await import('./doctor.js')).doctorCommand,
)

export const execCommand = lazyCommand(
	{
		name: 'exec',
		aliases: ['e'],
		description: 'Run a single prompt headlessly: print the reply, or stream events with --json',
		passThrough: true,
	},
	async () => (await import('./exec.js')).execCommand,
)

export const residentCommand = lazyCommand(
	{
		name: 'resident',
		description: 'Manage persistent work and explicitly authorized resident runners (experimental)',
		passThrough: true,
	},
	async () => (await import('./resident.js')).residentCommand,
)

export const loginCommand = lazyCommand(
	{
		name: 'login',
		description: 'Sign in with a provider subscription and store the credential.',
		passThrough: true,
	},
	async () => (await import('./login.js')).loginCommand,
)

export const logoutCommand = lazyCommand(
	{
		name: 'logout',
		description: 'Remove a credential namzu stored on this machine.',
		passThrough: true,
	},
	async () => (await import('./login.js')).logoutCommand,
)

export const mcpCommand = lazyCommand(
	{ name: 'mcp', description: 'Manage user tool servers', passThrough: true },
	async () => (await import('./mcp.js')).mcpCommand,
)

export const drainCommand = lazyCommand(
	{
		name: 'drain',
		description: 'Continue a turn another process left behind (one pass, then exit)',
		passThrough: true,
	},
	async () => (await import('./drain.js')).drainCommand,
)

export const evalCommand = lazyCommand(
	{ name: 'eval', description: 'Run eval suites and set an exit code', passThrough: true },
	async () => (await import('./eval.js')).evalCommand,
)

export const historyCommand = lazyCommand(
	{
		name: 'history',
		description: "Print a session's persisted messages as JSON (for host UIs)",
		passThrough: true,
	},
	async () => (await import('./host-queries.js')).historyCommand,
)

export const skillsCommand = lazyCommand(
	{
		name: 'skills',
		description: 'List skills available to a working directory',
		passThrough: true,
	},
	async () => (await import('./skills.js')).skillsCommand,
)

export const skillsJSONCommand = lazyCommand(
	{
		name: 'skills-json',
		description: 'Print discovered skills as JSON (for host UIs)',
		passThrough: true,
	},
	async () => (await import('./host-queries.js')).skillsJSONCommand,
)

export const providersJSONCommand = lazyCommand(
	{
		name: 'providers-json',
		description: 'Print providers + per-provider models as JSON (for host UIs)',
		passThrough: true,
	},
	async () => (await import('./host-queries.js')).providersJSONCommand,
)

export const upgradeCommand = lazyCommand(
	{
		name: 'upgrade',
		description: 'Update the active global Namzu installation',
		passThrough: true,
	},
	async () => (await import('./upgrade.js')).upgradeCommand,
)

export const serveCommand = lazyCommand(
	{
		name: 'serve',
		description: 'namzu needs no central server; each session is a process',
	},
	async () => (await import('./serve.js')).serveCommand,
)

export const stateCommand = lazyCommand(
	{
		name: 'state',
		description: 'Inspect local Namzu state without changing it',
		passThrough: true,
	},
	async () => (await import('./state.js')).stateCommand,
)

export const scheduleCommand = lazyCommand(
	{
		name: 'schedule',
		description: 'Scheduled jobs that run while namzu is closed, and the service that runs them',
		passThrough: true,
	},
	async () => (await import('./schedule.js')).scheduleCommand,
)

export const browserCommand = lazyCommand(
	{
		name: 'browser',
		description: 'Browser profiles for the browser tools: sign in, list, status, install, remove',
		passThrough: true,
	},
	async () => (await import('./browser.js')).browserCommand,
)

/** `pal` is built per launch, from the command that resumes a conversation. */
export function createLazyPalCommand(
	resumeCommand?: readonly [string, ...string[]],
): LazyCommandDef {
	return lazyCommand(
		{
			name: 'pal',
			description: 'Create and operate persistent Pals with their own local virtual computers',
			passThrough: true,
		},
		async () => (await import('./pal.js')).createPalCommand(resumeCommand),
	)
}

/** `worktree` is built per launch, from the function that opens a conversation in a worktree. */
export function createLazyWorktreeCommand(
	open: Parameters<typeof createWorktreeCommand>[0],
): LazyCommandDef {
	return lazyCommand(
		{
			name: 'worktree',
			description: 'Create, fork, list and resume managed Git worktrees',
			passThrough: true,
		},
		async () => (await import('./worktree.js')).createWorktreeCommand(open),
	)
}
