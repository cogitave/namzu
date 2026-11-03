/**
 * A private message from a hosted session to the host that owns its terminal.
 *
 * A session started by the workspaces host cannot open the workspaces screen itself: the
 * host already is that screen. When its `←` gesture fires it writes this
 * operating-system-command sequence to its own terminal instead; the host reads
 * the session's output, strips the sequence and acts on it.
 */

/** What a hosted session can ask of its host. */
export type SignalName = 'zoom-out'

const NAMES: readonly string[] = ['zoom-out']

export function isSignalName(name: string): name is SignalName {
	return NAMES.includes(name)
}

const HEAD = '\x1b]7777;namzu-workspaces;'
/** What a build from before the rename wrote. A host still strips it, so no escape leaks into a pane. */
const LEGACY_HEAD = '\x1b]7777;namzu-spaces;'
const HEADS: readonly string[] = [HEAD, LEGACY_HEAD]
const BEL = '\x07'
const ST = '\x1b\\'
/** A pending sequence longer than this is not ours; it is passed on. */
const MAX_PENDING = 64

/** The bytes a session writes to ask its host to leave it. */
export function workspacesSignal(name: SignalName): string {
	return `${HEAD}${name}${BEL}`
}

/** True when this process is a session the workspaces host started directly. */
export function hostedByHost(env: NodeJS.ProcessEnv, ppid: number): boolean {
	return hostSlot(env) !== undefined && hostPid(env) === String(ppid)
}

/** The slot the host gave this terminal. The names from before the rename are read too, so a host and a session of different builds still find each other. */
export function hostSlot(env: NodeJS.ProcessEnv): string | undefined {
	return env.NAMZU_WORKSPACE_SLOT ?? env.NAMZU_SPACE_SLOT
}

function hostPid(env: NodeJS.ProcessEnv): string | undefined {
	return env.NAMZU_WORKSPACE_HOST_PID ?? env.NAMZU_SPACE_HOST_PID
}

/**
 * Takes the sequences out of a session's output as it arrives. A sequence cut
 * in two by the terminal is held back until its other half comes; anything that
 * turns out not to be ours is released unchanged.
 */
export class SignalFilter {
	private carry = ''

	feed(data: string): { text: string; signals: SignalName[] } {
		const input = this.carry + data
		this.carry = ''
		const signals: SignalName[] = []
		let text = ''
		let i = 0
		while (i < input.length) {
			const start = input.indexOf('\x1b', i)
			if (start < 0) {
				text += input.slice(i)
				break
			}
			text += input.slice(i, start)
			const rest = input.slice(start)
			const head = HEADS.find((candidate) => rest.startsWith(candidate))
			if (head !== undefined) {
				const body = rest.slice(head.length)
				const bel = body.indexOf(BEL)
				const st = body.indexOf(ST)
				const end = bel >= 0 && (st < 0 || bel < st) ? bel : st
				if (end >= 0) {
					const name = body.slice(0, end)
					const length = head.length + end + (end === st ? ST.length : BEL.length)
					if (isSignalName(name)) signals.push(name)
					else text += rest.slice(0, length)
					i = start + length
					continue
				}
				if (rest.length <= MAX_PENDING) {
					this.carry = rest
					break
				}
			} else if (
				HEADS.some((candidate) => rest.length < candidate.length && candidate.startsWith(rest))
			) {
				this.carry = rest
				break
			}
			text += '\x1b'
			i = start + 1
		}
		return { text, signals }
	}
}
