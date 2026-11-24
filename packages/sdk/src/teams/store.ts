import { randomUUID } from 'node:crypto'
import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	rmSync,
	rmdirSync,
	writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { resolveNamzuHome } from '../session/home.js'
import { lockedSync, sleepSync, writeAtomicSync } from './fs-sync.js'
import { TEAM_LEAD_NAME, normalizeTeamName, teamNameProblem, teammateNameProblem } from './names.js'
import {
	type MailDraft,
	type MailEntry,
	MailEntrySchema,
	TEAM_CONFIG_VERSION,
	type TeamBackendKind,
	type TeamConfig,
	TeamConfigSchema,
	type TeamMember,
	TeamStoreError,
} from './types.js'

/**
 * The teams on this machine, under `<NAMZU_HOME>/teams/<team>/`:
 *
 * - `config.json`: the team and its members, changed only through this class, under a lock and by
 *   rename, so two processes naming a member at once cannot both succeed.
 * - `inboxes/<name>.json`: one mailbox per member and one for `lead` (the name is folded to lower case,
 *   so two spellings of a name never share or split a file). A JSON array of mail entries.
 *
 * `active` on a member means it holds a place in the team: it is set when the name is reserved and
 * cleared when the teammate ends, so the size limit counts what is running or about to.
 *
 * @experimental
 */

/** Colours handed out in order, so members are told apart on a screen. */
export const TEAM_COLORS = [
	'blue',
	'green',
	'purple',
	'orange',
	'pink',
	'cyan',
	'yellow',
	'red',
] as const

/** One piece of mail may carry this much text. */
export const MAX_MAIL_TEXT_BYTES = 64 * 1024
/** A mailbox keeps this many entries; the oldest read ones go first. */
export const MAX_MAIL_ENTRIES = 500
/** A team directory with no readable config is left alone this long, so one being created is not swept. */
export const TEAM_CREATE_GRACE_MS = 60_000

export interface TeamStoreOptions {
	/** The directory teams live in. Default `<NAMZU_HOME>/teams`. */
	readonly rootDir?: string
	/** Environment and OS home for resolving `NAMZU_HOME`; tests only. */
	readonly env?: NodeJS.ProcessEnv
	readonly home?: string
	/** Tests only: replace the wall clock, the wait between lock retries and the liveness check. */
	readonly now?: () => number
	readonly sleep?: (ms: number) => void
	readonly isProcessAlive?: (pid: number) => boolean
}

export interface CreateTeamInput {
	readonly name: string
	readonly leadSessionId: string
	readonly leadPid?: number
	readonly project?: string
	readonly cwd?: string
}

export interface ReserveMemberInput {
	readonly name: string
	readonly backend?: TeamBackendKind
	readonly agentType?: string
	readonly color?: string
	/** Refuse with `team_full` when this many members already hold a place. */
	readonly maxMembers?: number
}

export interface MailReadOptions {
	readonly unreadOnly?: boolean
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		// EPERM: the process exists but is another user's.
		return (error as NodeJS.ErrnoException).code === 'EPERM'
	}
}

function errnoOf(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code
}

export class TeamStore {
	readonly rootDir: string
	private readonly now: () => number
	private readonly sleep: (ms: number) => void
	private readonly alive: (pid: number) => boolean

	constructor(options: TeamStoreOptions = {}) {
		this.rootDir =
			options.rootDir ??
			join(
				resolveNamzuHome({
					...(options.env ? { env: options.env } : {}),
					...(options.home ? { home: options.home } : {}),
				}),
				'teams',
			)
		this.now = options.now ?? Date.now
		this.sleep = options.sleep ?? sleepSync
		this.alive = options.isProcessAlive ?? processAlive
	}

	// ─── paths ───────────────────────────────────────────────────────────

	teamDir(team: string): string {
		const problem = teamNameProblem(team)
		if (problem) throw new TeamStoreError('bad_name', problem)
		return join(this.rootDir, team)
	}

	configPath(team: string): string {
		return join(this.teamDir(team), 'config.json')
	}

	inboxPath(team: string, name: string): string {
		return join(this.teamDir(team), 'inboxes', `${normalizeTeamName(name)}.json`)
	}

	// ─── teams ───────────────────────────────────────────────────────────

	/**
	 * Create a team. Asking again with the same lead session returns the team that is there (a resumed
	 * lead); a different lead session is `team_exists`.
	 */
	createTeam(input: CreateTeamInput): TeamConfig {
		const dir = this.teamDir(input.name)
		mkdirSync(this.rootDir, { recursive: true, mode: 0o700 })
		try {
			mkdirSync(dir, { mode: 0o700 })
		} catch (error) {
			if (errnoOf(error) !== 'EEXIST') throw error
			const existing = this.readTeam(input.name)
			if (existing && existing.leadSessionId === input.leadSessionId) return existing
			throw new TeamStoreError('team_exists', `The team ${input.name} already exists.`)
		}
		mkdirSync(join(dir, 'inboxes'), { mode: 0o700 })
		const config: TeamConfig = {
			version: TEAM_CONFIG_VERSION,
			name: input.name,
			leadSessionId: input.leadSessionId,
			leadPid: input.leadPid ?? process.pid,
			...(input.project !== undefined ? { project: input.project } : {}),
			...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
			createdAt: this.now(),
			members: [],
		}
		this.writeConfig(input.name, config)
		return config
	}

	/** The team's config, or undefined when there is no such team or its file is unreadable. */
	readTeam(team: string): TeamConfig | undefined {
		let text: string
		try {
			text = readFileSync(this.configPath(team), 'utf8')
		} catch (error) {
			if (error instanceof TeamStoreError) throw error
			return undefined
		}
		try {
			const parsed = TeamConfigSchema.safeParse(JSON.parse(text))
			return parsed.success ? parsed.data : undefined
		} catch {
			return undefined
		}
	}

	listTeams(): string[] {
		let entries: string[]
		try {
			entries = readdirSync(this.rootDir)
		} catch {
			return []
		}
		return entries.filter((name) => !teamNameProblem(name) && this.readTeam(name) !== undefined)
	}

	/** Remove a team's directory. Returns false when there was none. Tasks and transcripts live elsewhere. */
	deleteTeam(team: string): boolean {
		const dir = this.teamDir(team)
		let entry: ReturnType<typeof lstatSync>
		try {
			entry = lstatSync(dir)
		} catch {
			return false
		}
		if (entry.isSymbolicLink() || !entry.isDirectory()) return false
		rmSync(dir, { recursive: true, force: true })
		return true
	}

	/**
	 * Remove the directories of teams whose lead is gone: the lead's process no longer exists, or the
	 * directory has no readable config and was last changed more than `graceMs` ago. A team that records
	 * no lead process is never removed here. Returns the names removed.
	 */
	sweepOrphans(options: { readonly graceMs?: number } = {}): string[] {
		const grace = options.graceMs ?? TEAM_CREATE_GRACE_MS
		let entries: string[]
		try {
			entries = readdirSync(this.rootDir)
		} catch {
			return []
		}
		const removed: string[] = []
		for (const name of entries) {
			if (teamNameProblem(name)) continue
			const dir = join(this.rootDir, name)
			let entry: ReturnType<typeof lstatSync>
			try {
				entry = lstatSync(dir)
			} catch {
				continue
			}
			if (entry.isSymbolicLink() || !entry.isDirectory()) continue
			const config = this.readTeam(name)
			const gone = config
				? config.leadPid !== undefined && !this.alive(config.leadPid)
				: this.now() - entry.mtimeMs > grace
			if (!gone) continue
			rmSync(dir, { recursive: true, force: true })
			removed.push(name)
		}
		return removed
	}

	// ─── members ─────────────────────────────────────────────────────────

	/**
	 * Take a name in the team's file. Two callers asking for one name at once: exactly one gets it, the
	 * other gets `name_taken`. The member holds a place from now on; hand it back with
	 * {@link rollbackMember} if starting it fails, or let {@link withReservedMember} do both.
	 */
	reserveMember(team: string, input: ReserveMemberInput): TeamMember {
		const problem = teammateNameProblem(input.name)
		if (problem) throw new TeamStoreError('bad_name', problem)
		return this.mutate(team, (config) => {
			const folded = normalizeTeamName(input.name)
			if (config.members.some((m) => normalizeTeamName(m.name) === folded))
				throw new TeamStoreError('name_taken', `${input.name} is already a member of ${team}.`)
			if (
				input.maxMembers !== undefined &&
				config.members.filter((m) => m.active).length >= input.maxMembers
			)
				throw new TeamStoreError(
					'team_full',
					`The team ${team} already has ${input.maxMembers} teammates at work.`,
				)
			const member: TeamMember = {
				id: randomUUID(),
				name: input.name,
				color: input.color ?? this.nextColor(config),
				joinedAt: this.now(),
				backend: input.backend ?? 'in-process',
				active: true,
				...(input.agentType !== undefined ? { agentType: input.agentType } : {}),
			}
			return { config: { ...config, members: [...config.members, member] }, result: member }
		})
	}

	/**
	 * Give back a reservation that never started. Removes exactly the member with this id, so a later
	 * member that took the same name is never touched. False when it is already gone, or the team is.
	 */
	rollbackMember(team: string, memberId: string): boolean {
		try {
			return this.mutate(team, (config) => {
				const keep = config.members.filter((m) => m.id !== memberId)
				if (keep.length === config.members.length) return { config, result: false }
				return { config: { ...config, members: keep }, result: true }
			})
		} catch (error) {
			if (error instanceof TeamStoreError && error.code === 'team_not_found') return false
			throw error
		}
	}

	/**
	 * Reserve a name, run `start`, and give the name back if `start` throws: a teammate is either
	 * running under its name or the name is free again.
	 */
	async withReservedMember<T>(
		team: string,
		input: ReserveMemberInput,
		start: (member: TeamMember) => Promise<T>,
	): Promise<{ readonly member: TeamMember; readonly result: T }> {
		const member = this.reserveMember(team, input)
		try {
			return { member, result: await start(member) }
		} catch (error) {
			this.rollbackMember(team, member.id)
			throw error
		}
	}

	/** Mark a member as holding a place (resumed) or not (ended). Resuming is refused over `maxMembers`. */
	setMemberActive(team: string, name: string, active: boolean, maxMembers?: number): TeamMember {
		return this.mutate(team, (config) => {
			const folded = normalizeTeamName(name)
			const at = config.members.findIndex((m) => normalizeTeamName(m.name) === folded)
			const current = config.members[at]
			if (current === undefined)
				throw new TeamStoreError('member_not_found', `${name} is not a member of ${team}.`)
			if (current.active === active) return { config, result: current }
			if (
				active &&
				maxMembers !== undefined &&
				config.members.filter((m) => m.active).length >= maxMembers
			)
				throw new TeamStoreError(
					'team_full',
					`The team ${team} already has ${maxMembers} teammates at work.`,
				)
			const next: TeamMember = { ...current, active }
			const members = config.members.slice()
			members[at] = next
			return { config: { ...config, members }, result: next }
		})
	}

	/** Remove a member and its mailbox. False when there is no such member. */
	removeMember(team: string, name: string): boolean {
		const folded = normalizeTeamName(name)
		const removed = this.mutate(team, (config) => {
			const keep = config.members.filter((m) => normalizeTeamName(m.name) !== folded)
			if (keep.length === config.members.length) return { config, result: false }
			return { config: { ...config, members: keep }, result: true }
		})
		if (removed) rmSync(this.inboxPath(team, name), { force: true })
		return removed
	}

	// ─── mail ────────────────────────────────────────────────────────────

	/**
	 * Add one piece of mail to a member's mailbox (or the lead's). The file is made if it is not there
	 * (create-exclusive), then read, added to and replaced by rename under a lock, so appends from many
	 * processes are all kept. Refused for a team that is gone, a recipient that is not in it, and text
	 * over {@link MAX_MAIL_TEXT_BYTES}.
	 */
	appendMail(team: string, to: string, draft: MailDraft): MailEntry {
		if (Buffer.byteLength(draft.text, 'utf8') > MAX_MAIL_TEXT_BYTES)
			throw new TeamStoreError(
				'too_large',
				`A message may be at most ${MAX_MAIL_TEXT_BYTES / 1024} KiB.`,
			)
		this.requireRecipient(team, to)
		const path = this.inboxPath(team, to)
		this.ensureInbox(team, path)
		const entry: MailEntry = {
			id: randomUUID(),
			from: draft.from,
			text: draft.text,
			...(draft.summary !== undefined ? { summary: draft.summary } : {}),
			at: new Date(this.now()).toISOString(),
			...(draft.kind !== undefined ? { kind: draft.kind } : {}),
		}
		this.changeInbox(team, path, (entries) => [...entries, entry])
		return entry
	}

	/** The valid entries in a mailbox, oldest first. An entry that does not match the schema is left out. */
	readMail(team: string, name: string, options: MailReadOptions = {}): MailEntry[] {
		const entries = this.readInbox(this.inboxPath(team, name)).entries
		return options.unreadOnly ? entries.filter((e) => e.read !== true) : entries
	}

	/** Take the unread mail and mark it read, in one step: no entry is handed out twice. */
	drainMail(team: string, name: string): MailEntry[] {
		const path = this.inboxPath(team, name)
		if (!existsSync(path)) return []
		let taken: MailEntry[] = []
		this.changeInbox(team, path, (entries) => {
			taken = entries.filter((e) => e.read !== true)
			return entries.map((e) => (e.read === true ? e : { ...e, read: true }))
		})
		return taken
	}

	markRead(team: string, name: string, ids: readonly string[]): void {
		const path = this.inboxPath(team, name)
		if (!existsSync(path)) return
		const wanted = new Set(ids)
		this.changeInbox(team, path, (entries) =>
			entries.map((e) => (wanted.has(e.id) && e.read !== true ? { ...e, read: true } : e)),
		)
	}

	/**
	 * Rewrite a mailbox without its invalid entries and with at most `keepRead` read ones (the newest).
	 * Unread mail is always kept. Returns how many entries were dropped.
	 */
	pruneMail(team: string, name: string, options: { readonly keepRead?: number } = {}): number {
		const path = this.inboxPath(team, name)
		if (!existsSync(path)) return 0
		const keepRead = options.keepRead ?? 50
		let dropped = 0
		this.changeInbox(team, path, (entries, invalid) => {
			const read = entries.filter((e) => e.read === true)
			const excess = new Set(read.slice(0, Math.max(0, read.length - keepRead)).map((e) => e.id))
			dropped = invalid + excess.size
			return entries.filter((e) => !excess.has(e.id))
		})
		return dropped
	}

	// ─── internals ───────────────────────────────────────────────────────

	private nextColor(config: TeamConfig): string {
		const used = new Set(config.members.map((m) => m.color))
		return (
			TEAM_COLORS.find((c) => !used.has(c)) ??
			TEAM_COLORS[config.members.length % TEAM_COLORS.length] ??
			'blue'
		)
	}

	private writeConfig(team: string, config: TeamConfig): void {
		writeAtomicSync(this.configPath(team), `${JSON.stringify(config, null, 2)}\n`, this.sleep)
	}

	/** Remove a team directory this call may have recreated while taking a lock on a team that is gone. */
	private dropRecreated(team: string): void {
		try {
			if (existsSync(this.configPath(team))) return
			rmdirSync(join(this.teamDir(team), 'inboxes'))
		} catch {
			// Not empty, or not there: nothing to undo.
		}
		try {
			if (!existsSync(this.configPath(team))) rmdirSync(this.teamDir(team))
		} catch {
			// Not empty, or not there.
		}
	}

	/** Change the config under its lock. Refused with `team_not_found` when the team has been removed. */
	private mutate<T>(
		team: string,
		change: (config: TeamConfig) => { readonly config: TeamConfig; readonly result: T },
	): T {
		const path = this.configPath(team)
		if (!existsSync(path)) throw new TeamStoreError('team_not_found', `There is no team ${team}.`)
		let found = true
		try {
			return lockedSync(path, this.sleep, () => {
				const current = this.readTeam(team)
				if (current === undefined) {
					found = false
					throw new TeamStoreError('team_not_found', `There is no team ${team}.`)
				}
				const next = change(current)
				if (next.config !== current) this.writeConfig(team, next.config)
				return next.result
			})
		} finally {
			if (!found) this.dropRecreated(team)
		}
	}

	private requireRecipient(team: string, to: string): void {
		const config = this.readTeam(team)
		if (config === undefined)
			throw new TeamStoreError('team_not_found', `There is no team ${team}.`)
		const folded = normalizeTeamName(to)
		if (folded === TEAM_LEAD_NAME) return
		if (!config.members.some((m) => normalizeTeamName(m.name) === folded))
			throw new TeamStoreError('unknown_recipient', `${to} is not a member of ${team}.`)
	}

	private ensureInbox(team: string, path: string): void {
		try {
			mkdirSync(join(this.teamDir(team), 'inboxes'), { mode: 0o700 })
		} catch (error) {
			const code = errnoOf(error)
			if (code === 'ENOENT') throw new TeamStoreError('team_not_found', `There is no team ${team}.`)
			if (code !== 'EEXIST') throw error
		}
		try {
			const fd = openSync(path, 'wx', 0o600)
			try {
				writeSync(fd, '[]\n')
			} finally {
				closeSync(fd)
			}
		} catch (error) {
			if (errnoOf(error) !== 'EEXIST') throw error
		}
	}

	private readInbox(path: string): { entries: MailEntry[]; invalid: number } {
		let text: string
		try {
			text = readFileSync(path, 'utf8')
		} catch {
			return { entries: [], invalid: 0 }
		}
		let raw: unknown
		try {
			raw = JSON.parse(text)
		} catch {
			return { entries: [], invalid: 1 }
		}
		if (!Array.isArray(raw)) return { entries: [], invalid: 1 }
		const entries: MailEntry[] = []
		let invalid = 0
		for (const item of raw) {
			const parsed = MailEntrySchema.safeParse(item)
			if (parsed.success) entries.push(parsed.data)
			else invalid++
		}
		return { entries, invalid }
	}

	/** Read, change and replace a mailbox under its lock. Invalid entries are dropped on the way, and the size is bounded. */
	private changeInbox(
		team: string,
		path: string,
		change: (entries: MailEntry[], invalid: number) => MailEntry[],
	): void {
		let found = true
		try {
			lockedSync(path, this.sleep, () => {
				if (!existsSync(this.configPath(team))) {
					found = false
					throw new TeamStoreError('team_not_found', `There is no team ${team}.`)
				}
				const { entries, invalid } = this.readInbox(path)
				let next = change(entries, invalid)
				if (next.length > MAX_MAIL_ENTRIES) {
					let over = next.length - MAX_MAIL_ENTRIES
					next = next.filter((e) => {
						if (over > 0 && e.read === true) {
							over--
							return false
						}
						return true
					})
					if (next.length > MAX_MAIL_ENTRIES) next = next.slice(next.length - MAX_MAIL_ENTRIES)
				}
				try {
					writeAtomicSync(path, `${JSON.stringify(next)}\n`, this.sleep)
				} catch (error) {
					if (errnoOf(error) === 'ENOENT') {
						found = false
						throw new TeamStoreError('team_not_found', `There is no team ${team}.`)
					}
					throw error
				}
			})
		} finally {
			if (!found) this.dropRecreated(team)
		}
	}
}
