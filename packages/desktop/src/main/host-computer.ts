import { hostname } from 'node:os'
import type { HumanComputerView } from '../shared/protocol.js'

/** Native host identity only. This machine is never a target of Pal input. */
export function humanComputer(): HumanComputerView {
	return {
		name: Array.from(hostname())
			.filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
			.join('')
			.slice(0, 255),
		platform:
			process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux'
				? process.platform
				: 'other',
	}
}
