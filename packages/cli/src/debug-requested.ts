/**
 * Whether detail was asked for: `NAMZU_DEBUG=1` or `--debug` on the command
 * line. Its own module because the command shell asks it when a crash is
 * reported, and importing it from the terminal screens' module loaded them.
 */
export function debugRequested(
	env: Record<string, string | undefined> = process.env,
	argv: readonly string[] = process.argv,
): boolean {
	const flag = env.NAMZU_DEBUG
	if (flag !== undefined && flag !== '' && flag !== '0' && flag.toLowerCase() !== 'false')
		return true
	return argv.includes('--debug')
}
