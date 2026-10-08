interface RuntimeNodeOptions {
	platform: NodeJS.Platform
	allowedNodeEnvironmentFlags: Pick<ReadonlySet<string>, 'has'>
	nodeOptions?: string
}

const caOptions = new Set([
	'--use-system-ca',
	'--no-use-system-ca',
	'--use-bundled-ca',
	'--no-use-bundled-ca',
	'--use-openssl-ca',
	'--no-use-openssl-ca',
])

function hasExplicitCaOption(options: string): boolean {
	let token = ''
	let quoted = false
	for (let i = 0; i <= options.length; i++) {
		const character = options[i]
		if (character === '"') quoted = !quoted
		else if (quoted && character === '\\' && options[i + 1] !== undefined) token += options[++i]
		else if (character === undefined || (!quoted && /\s/.test(character))) {
			if (caOptions.has(token.split('=', 1)[0]?.replaceAll('_', '-') ?? '')) return true
			token = ''
		} else token += character
	}
	return false
}

const processRuntime = (): RuntimeNodeOptions => ({
	platform: process.platform,
	allowedNodeEnvironmentFlags: process.allowedNodeEnvironmentFlags,
	nodeOptions: process.env.NODE_OPTIONS,
})

/** The Node flags the runtime needs ahead of the CLI entry; inherited trust options stay authoritative. */
export function desktopRuntimeNodeFlags(runtime: RuntimeNodeOptions = processRuntime()): string[] {
	const useSystemCa =
		runtime.platform === 'win32' &&
		runtime.allowedNodeEnvironmentFlags.has('--use-system-ca') &&
		!hasExplicitCaOption(runtime.nodeOptions ?? '')
	return useSystemCa ? ['--use-system-ca'] : []
}

/** Node flags must precede the CLI entry; inherited trust options remain authoritative. */
export function desktopRuntimeNodeArgs(
	cliEntry: string,
	runtime: RuntimeNodeOptions = processRuntime(),
): string[] {
	return [...desktopRuntimeNodeFlags(runtime), cliEntry, 'acp', '--desktop']
}
