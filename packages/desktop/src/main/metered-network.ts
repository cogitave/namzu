import { execFile } from 'node:child_process'
import type { MeteredState } from '../shared/os-state.js'

/** The Windows Runtime's answer for the internet connection's cost, as one word. */
const COST_QUERY =
	"$p=[Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]::GetInternetConnectionProfile(); if($p){$p.GetConnectionCost().NetworkCostType}else{'None'}"

/** `Fixed` and `Variable` are the costs Windows gives a connection that is metered or capped. */
export function parseCostType(output: string): MeteredState {
	const word = output.trim().split(/\s+/u)[0]?.toLowerCase()
	if (word === 'fixed' || word === 'variable') return 'metered'
	if (word === 'unrestricted') return 'unmetered'
	return 'unknown'
}

export type RunCostQuery = () => Promise<string>

/** Asks Windows PowerShell for the connection's cost. Rejects on any failure, so the caller says "unknown". */
export function windowsCostQuery(systemRoot: string | undefined): RunCostQuery {
	const root = systemRoot || 'C:\\Windows'
	const shell = `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
	return () =>
		new Promise((resolve, reject) => {
			execFile(
				shell,
				['-NoProfile', '-NonInteractive', '-Command', COST_QUERY],
				{ timeout: 8000, windowsHide: true, maxBuffer: 4096 },
				(error, stdout) => (error ? reject(error) : resolve(String(stdout))),
			)
		})
}

export interface MeteredWatchOptions {
	/** Absent where the cost cannot be read: the state then stays unknown and nothing waits. */
	query?: RunCostQuery
	every: (ms: number, run: () => void) => () => void
	onChange: (state: MeteredState) => void
}

export const METERED_RECHECK_MS = 5 * 60_000

/** The last answer about the connection's cost, asked again on a slow beat and when the person asks. */
export class MeteredWatch {
	private current: MeteredState = 'unknown'
	private stop: (() => void) | undefined

	constructor(private readonly options: MeteredWatchOptions) {}

	/** Whether the cost can be read here at all. */
	available(): boolean {
		return this.options.query !== undefined
	}

	state(): MeteredState {
		return this.current
	}

	start(): void {
		if (!this.options.query || this.stop) return
		this.stop = this.options.every(METERED_RECHECK_MS, () => void this.refresh())
		void this.refresh()
	}

	async refresh(): Promise<MeteredState> {
		if (!this.options.query) return this.current
		let next: MeteredState
		try {
			next = parseCostType(await this.options.query())
		} catch {
			next = 'unknown'
		}
		if (next !== this.current) {
			this.current = next
			this.options.onChange(next)
		}
		return this.current
	}

	close(): void {
		this.stop?.()
		this.stop = undefined
	}
}
