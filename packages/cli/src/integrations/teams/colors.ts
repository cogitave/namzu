/**
 * The colour a teammate wears on the lead's screen: in the name beside a message, on its idle line,
 * on a task it holds, on the prompt while its transcript is open. Eight colours, handed out in the
 * order members join, the lead's own first. A screen only reads the names back; nothing here draws.
 */

/** The eight colours, in the order they are handed out. Plain terminal colours, so every theme draws them. */
export const TEAM_COLORS = [
	'red',
	'blue',
	'green',
	'yellow',
	'magenta',
	'#ff8700',
	'#ff69b4',
	'cyan',
] as const

export type TeamColor = (typeof TEAM_COLORS)[number]

/** The name the lead goes by when it is given its own colour. */
export const LEAD_COLOR_KEY = '\u0000lead'

/**
 * Round-robin colours for one team: asking for a name that already has one returns the same, a new
 * name takes the next. The lead takes the first before any teammate, as the team starts.
 */
export class TeamColors {
	private readonly byName = new Map<string, TeamColor>()
	private next = 0

	constructor() {
		this.assign(LEAD_COLOR_KEY)
	}

	assign(name: string): TeamColor {
		const known = this.byName.get(name)
		if (known) return known
		const color = TEAM_COLORS[this.next % TEAM_COLORS.length] as TeamColor
		this.next += 1
		this.byName.set(name, color)
		return color
	}

	/** The colour a name has, without giving it one. */
	get(name: string): TeamColor | undefined {
		return this.byName.get(name)
	}

	/** The lead's colour. */
	lead(): TeamColor {
		return this.assign(LEAD_COLOR_KEY)
	}
}

/**
 * A colour for a name that was never given one (mail written before colours were kept, or a sender
 * the roster no longer lists): blue or pink by a hash of the name, so the same name looks the same
 * every time and never takes the lead's colour.
 */
export function fallbackTeamColor(name: string): TeamColor {
	let hash = 0
	for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
	return hash % 2 === 0 ? 'blue' : '#ff69b4'
}
