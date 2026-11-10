import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import type { DecisionConfig, DecisionPointsConfig } from '../../config/schema.js'
import { readStoredApiKey, writeStoredApiKey } from '../providers/credential-store.js'
import { resolveNamzuHome } from '../state/home.js'

/**
 * The decision model a person connected from the terminal.
 *
 * The endpoint, deployment or url, and model are not secret: they are kept in
 * `decision-connection.json` beside the config, and written into the user
 * config's `decision` block. The key is secret and goes to the private
 * credential store under {@link DECISION_KEY_ID}, never to a config file.
 */

/** The id the decision key has in the private credential store (`api-keys.json`). */
export const DECISION_KEY_ID = 'decision'

/**
 * What the points start as when a person connects. A point that can only miss a chime
 * (`notify`) or withdraw a suggestion (`skill`) acts; a point that can keep a memory
 * out of the store (`memory`) or press a control (`pick`) only records until the person
 * has seen the log and turns it on.
 */
export const DEFAULT_CONNECTED_POINTS: DecisionPointsConfig = {
	notify: 'on',
	memory: 'shadow',
	skill: 'on',
	pick: 'shadow',
}

export type SavedConnection =
	| { readonly provider: 'azure'; readonly endpoint: string; readonly deployment: string }
	| { readonly provider: 'http'; readonly url: string; readonly model?: string }

export interface ConnectionOptions {
	/** The OS home (testing); the namzu home is resolved under it. */
	readonly home?: string
	readonly env?: NodeJS.ProcessEnv
}

function homeDir(opts: ConnectionOptions): string {
	return resolveNamzuHome({
		...(opts.home ? { home: opts.home } : {}),
		env: opts.env ?? process.env,
	})
}

export function connectionPath(opts: ConnectionOptions = {}): string {
	return join(homeDir(opts), 'decision-connection.json')
}

export function readConnection(opts: ConnectionOptions = {}): SavedConnection | undefined {
	try {
		const parsed = JSON.parse(readFileSync(connectionPath(opts), 'utf8')) as Record<string, unknown>
		if (
			parsed.provider === 'azure' &&
			typeof parsed.endpoint === 'string' &&
			typeof parsed.deployment === 'string'
		) {
			return { provider: 'azure', endpoint: parsed.endpoint, deployment: parsed.deployment }
		}
		if (parsed.provider === 'http' && typeof parsed.url === 'string') {
			return {
				provider: 'http',
				url: parsed.url,
				...(typeof parsed.model === 'string' && parsed.model ? { model: parsed.model } : {}),
			}
		}
	} catch {
		// Absent or damaged: nothing is connected.
	}
	return undefined
}

function writeAtomic(path: string, body: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	const temp = `${path}.${randomUUID()}.tmp`
	try {
		writeFileSync(temp, body, { mode: 0o600 })
		renameSync(temp, path)
	} catch (error) {
		rmSync(temp, { force: true })
		throw error
	}
}

export function writeConnection(conn: SavedConnection, opts: ConnectionOptions = {}): void {
	writeAtomic(connectionPath(opts), `${JSON.stringify(conn, null, 2)}\n`)
}

/** The `decision` block for a connection, with the points the person starts on. */
export function connectionToBlock(
	conn: SavedConnection,
	points: DecisionPointsConfig = DEFAULT_CONNECTED_POINTS,
): DecisionConfig {
	return { ...conn, points }
}

export function saveDecisionKey(key: string, opts: ConnectionOptions = {}): string {
	return writeStoredApiKey(DECISION_KEY_ID, key, opts.home)
}

export function readDecisionKey(opts: ConnectionOptions = {}): string | null {
	return readStoredApiKey(DECISION_KEY_ID, opts.home)
}

/**
 * Resolve `decision: true` in a raw user config to the block it stands for: the saved
 * connection with the default points, or nothing when none is connected. A mapping and
 * any other value are returned as they were.
 */
export function resolveDecisionShorthand(value: unknown, opts: ConnectionOptions = {}): unknown {
	if (value !== true) return value
	const conn = readConnection(opts)
	return conn ? connectionToBlock(conn) : undefined
}

/** What the user's config says about the decision model, read raw: the shorthand, a block, or nothing. */
export function readUserDecisionSetting(
	opts: ConnectionOptions = {},
): 'shorthand' | 'block' | 'absent' {
	try {
		const parsed = parseYaml(readFileSync(join(homeDir(opts), 'config.yaml'), 'utf8')) as Record<
			string,
			unknown
		> | null
		const value = parsed?.decision
		if (value === true) return 'shorthand'
		if (value !== undefined && value !== null && value !== false) return 'block'
	} catch {
		// No file, or one that does not parse: the loader reports that, not this.
	}
	return 'absent'
}

// --- the offer: asked after a model pick, answered once -------------------------------

export type OfferAnswer = 'later' | 'never'

export interface OfferRecord {
	readonly answer: OfferAnswer
	readonly at: string
}

export function offerPath(opts: ConnectionOptions = {}): string {
	return join(homeDir(opts), 'decision-offer.json')
}

export function readOffer(opts: ConnectionOptions = {}): OfferRecord | undefined {
	try {
		const parsed = JSON.parse(readFileSync(offerPath(opts), 'utf8')) as Record<string, unknown>
		if ((parsed.answer === 'later' || parsed.answer === 'never') && typeof parsed.at === 'string') {
			return { answer: parsed.answer, at: parsed.at }
		}
	} catch {
		// An unreadable record reads as never asked: one more question, never a skipped one.
	}
	return undefined
}

export function recordOffer(
	answer: OfferAnswer,
	opts: ConnectionOptions = {},
	now: () => Date = () => new Date(),
): void {
	writeAtomic(offerPath(opts), `${JSON.stringify({ answer, at: now().toISOString() })}\n`)
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Whether the offer is made now. Never after "Don't ask again"; at most once a day after
 * "Not now"; never while a model is connected or the kill switch is set.
 */
export function shouldOfferDecisionSetup(input: {
	readonly record: OfferRecord | undefined
	readonly setting: 'shorthand' | 'block' | 'absent'
	readonly env: NodeJS.ProcessEnv
	readonly now: number
}): boolean {
	if (input.env.NAMZU_NO_DECISION === '1') return false
	if (input.setting !== 'absent') return false
	if (!input.record) return true
	if (input.record.answer === 'never') return false
	const at = Date.parse(input.record.at)
	return Number.isNaN(at) || input.now - at >= DAY_MS
}

/** The one line `/status` shows: off, connected (with the points that act) or not connected. */
export function decisionStatusLine(input: {
	readonly config: DecisionConfig | undefined
	readonly connected: boolean
	readonly env: NodeJS.ProcessEnv
}): string {
	if (input.env.NAMZU_NO_DECISION === '1') return 'Off (NAMZU_NO_DECISION)'
	if (!input.config && !input.connected) return 'Not connected'
	const points = input.config?.points ?? {}
	const named = Object.entries(points)
		.filter(([, mode]) => mode !== 'off')
		.map(([name, mode]) => `${name} ${mode}`)
	return `Connected${named.length > 0 ? ` · ${named.join(', ')}` : ' · no point is on'}`
}
