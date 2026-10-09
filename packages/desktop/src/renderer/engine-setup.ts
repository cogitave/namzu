import type { HarnessView } from '../shared/protocol.js'

/** What a person needs to get an outside engine going: how to install it and how to sign in. */
export type ExternalEngine = Exclude<HarnessView['selected'], 'namzu'>
export type SetupPlatform = 'windows' | 'mac' | 'linux'

export interface InstallCommand {
	/** Where this command is run, or what it is, in a few words. */
	label: string
	command: string
}

export interface EngineSetup {
	name: string
	/** The program a terminal runs. */
	program: string
	install: InstallCommand[]
	signIn: { command: string; hint: string }
}

export function setupPlatform(userAgent: string): SetupPlatform {
	if (/Windows|Win32|Win64/iu.test(userAgent)) return 'windows'
	if (/Mac|Darwin/iu.test(userAgent)) return 'mac'
	return 'linux'
}

/**
 * The exact commands, per system. The first engine ships on npm for every system. The second has
 * its own installer for each system and an npm package for people who already use Node.
 */
export function engineSetup(engine: ExternalEngine, platform: SetupPlatform): EngineSetup {
	if (engine === 'codex-cli')
		return {
			name: 'Codex CLI',
			program: 'codex',
			install: [{ label: 'With npm', command: 'npm install -g @openai/codex' }],
			signIn: { command: 'codex login', hint: 'Follow the steps it shows.' },
		}
	return {
		name: 'Claude Code',
		program: 'claude',
		install: [
			platform === 'windows'
				? { label: 'In PowerShell', command: 'irm https://claude.ai/install.ps1 | iex' }
				: { label: 'In a terminal', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
			{ label: 'Or with npm', command: 'npm install -g @anthropic-ai/claude-code' },
		],
		signIn: {
			command: 'claude',
			hint: 'It asks you to sign in the first time you run it.',
		},
	}
}

export interface SignInHelp {
	engine: ExternalEngine
	name: string
	command: string
	hint: string
}

/**
 * The engine that is installed but signed out, read from the words of the error it raised. Only an
 * error that names an engine and says it needs an account counts; every other failure keeps its
 * own text and no sign-in advice.
 */
export function signInHelpFor(message: string): SignInHelp | undefined {
	if (!/signed[- ]in|sign in|log ?in|logged in|not authenticated|authenticat/iu.test(message))
		return undefined
	const engine: ExternalEngine | undefined = message.toLowerCase().includes('codex')
		? 'codex-cli'
		: message.toLowerCase().includes('claude')
			? 'claude-code'
			: undefined
	if (!engine) return undefined
	const setup = engineSetup(engine, 'linux')
	return { engine, name: setup.name, command: setup.signIn.command, hint: setup.signIn.hint }
}
