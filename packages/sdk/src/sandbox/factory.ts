import type { SandboxConfig, SandboxProvider } from '../types/sandbox/index.js'
import type { Logger } from '../utils/logger.js'
import { LocalSandboxProvider } from './provider/local.js'

export class SandboxProviderFactory {
	static create(config: SandboxConfig, log: Logger): SandboxProvider {
		switch (config.provider) {
			case 'local':
				return new LocalSandboxProvider(log)
			default: {
				const _exhaustive: never = config.provider
				throw new Error(`Unknown sandbox provider: ${_exhaustive}`)
			}
		}
	}
}
