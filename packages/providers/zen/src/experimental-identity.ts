import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * The floor the free-tier gate enforces: `OpenCode 1.18.0 or newer is required
 * to use the free tier`. Anything older answers HTTP 426 `UpgradeRequired`.
 * This pin is only a fallback for a host with no installed OpenCode — the
 * version actually advertised is resolved from the installed CLI when one can
 * be found, so this constant is never the reason a request is refused.
 */
export const FALLBACK_OPENCODE_VERSION = '1.18.35'

/**
 * The four tool names the free-tier gate requires in every anonymous request
 * body. A request missing any one of them — or carrying an empty or absent
 * `tools` — is refused with HTTP 403 `FreeTierError`. The names are the ones
 * OpenCode itself always registers, so a host that already offers tools under
 * these names needs nothing injected.
 */
export const ZEN_FREE_TIER_TOOL_NAMES = Object.freeze(['bash', 'glob', 'grep', 'read'] as const)

/** `OpenCode <version> (…)` as the installed CLI reports it. */
export function parseOpenCodeVersion(stdout: string): string | undefined {
	const match = /(\d+\.\d+\.\d+)/.exec(stdout)
	return match?.[1]
}

let resolvedUserAgent: string | undefined

function readInstalledOpenCodeVersion(): string | undefined {
	// A provider must not spawn a process per request, so the lookup runs once
	// per process and every failure — no binary, no permission, a version that
	// does not parse — falls through to the pinned floor. The stdin is closed
	// so a CLI that would prompt cannot hang the caller.
	try {
		const output = execFileSync('opencode', ['--version'], {
			timeout: 2_000,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		})
		return parseOpenCodeVersion(output)
	} catch {
		return undefined
	}
}

/**
 * The User-Agent an anonymous Zen request advertises.
 *
 * Resolution order: `OPENCODE_UA` verbatim, then the installed OpenCode CLI's
 * version, then {@link FALLBACK_OPENCODE_VERSION}. The free-tier gate reads the
 * version out of this header and refuses anything below 1.18, so a host that
 * has OpenCode installed stands in for the version it actually has.
 */
export function experimentalOpenCodeUserAgent(): string {
	if (resolvedUserAgent !== undefined) return resolvedUserAgent
	const override = process.env.OPENCODE_UA?.trim()
	const version = override || readInstalledOpenCodeVersion() || FALLBACK_OPENCODE_VERSION
	resolvedUserAgent = override
		? override
		: `opencode/${version} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`
	return resolvedUserAgent
}

/** Test seam: forget the memoized User-Agent so the next call re-resolves it. */
export function resetExperimentalOpenCodeUserAgent(): void {
	resolvedUserAgent = undefined
}

function timeHex(value: bigint): string {
	const time = Buffer.alloc(6)
	for (let index = 0; index < time.length; index++) {
		time[index] = Number((value >> BigInt(40 - index * 8)) & 0xffn)
	}
	return time.toString('hex')
}

function base62(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => ALPHABET[byte % 62]).join('')
}

/**
 * A session id in the exact descending shape OpenCode emits, which is the
 * shape the free-tier gate parses: `ses_`, 12 lowercase hex digits carrying
 * the inverted timestamp with its low 12 bits as `0xfff − counter`, then 14
 * base62 characters. The counter is 1, well inside the gate's 0–63 window.
 */
export function experimentalOpenCodeSessionId(namzuSessionId: string): string {
	const hash = createHash('sha256').update(namzuSessionId).digest()
	const uuidTime = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-/i.exec(namzuSessionId)
	const milliseconds = uuidTime
		? BigInt(`0x${uuidTime[1]}${uuidTime[2]}`)
		: BigInt(`0x${hash.subarray(0, 6).toString('hex')}`)
	return `ses_${timeHex(~(milliseconds * 0x1000n + 1n))}${base62(hash.subarray(6, 20))}`
}

/** One OpenCode-shaped message id per outbound model request. */
export function experimentalOpenCodeRequestId(): string {
	return `msg_${timeHex(BigInt(Date.now()) * 0x1000n + 1n)}${base62(randomBytes(14))}`
}
