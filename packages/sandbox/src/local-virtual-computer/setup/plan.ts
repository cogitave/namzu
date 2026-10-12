import { createHash } from 'node:crypto'
import type {
	PlanWslcSetup,
	WslcReadiness,
	WslcSetupBlock,
	WslcSetupPlan,
	WslcSetupStep,
} from './contract.js'
import { wslcAtLeastMinimum } from './readiness.js'
import { PINNED_WSL_PACKAGE } from './wsl-package.js'

/** Rough durations for the sentence the person reads; not promises. */
const ENABLE_FEATURES_SECONDS = 90
const INSTALL_WSL_SECONDS = 60
const RESTART_SECONDS = 90
/** Bytes per second assumed for a download and for loading the image. */
const DOWNLOAD_BYTES_PER_SECOND = 8_000_000
const LOAD_BYTES_PER_SECOND = 50_000_000
const LOAD_FIXED_SECONDS = 12

const BLOCKED: Partial<Record<WslcReadiness['state'], WslcSetupBlock>> = {
	unsupported: 'unsupported',
	'blocked-by-policy': 'blocked-by-policy',
	'virtualization-off': 'virtualization-off',
	'sdk-mismatch': 'sdk-mismatch',
}

/** JSON with sorted keys, so equal plans digest equally. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
	if (typeof value === 'object' && value !== null) {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
	}
	return JSON.stringify(value)
}

/**
 * Turn what a readiness inspection found into the steps that fix it. Pure: the
 * same facts give the same plan and the same id. Steps come from the facts, not
 * only from the headline state.
 */
export const planWslcSetup: PlanWslcSetup = (readiness, options) => {
	const pinned = options.wslPackage ?? PINNED_WSL_PACKAGE
	const manifest = options.manifest
	const finish = (steps: WslcSetupStep[], blocked?: WslcSetupBlock): WslcSetupPlan => {
		const id = createHash('sha256')
			.update(
				canonical({
					state: readiness.state,
					steps,
					blocked,
					wslVersion: pinned.version,
					manifest: manifest?.sha256 ?? null,
				}),
			)
			.digest('hex')
		return {
			id,
			state: readiness.state,
			steps,
			elevationPrompts: steps.some((step) => step.elevated) ? 1 : 0,
			mayRequireRestart: steps.some((step) => step.mayRequireRestart),
			...(blocked ? { blocked } : {}),
		}
	}

	const blocked = BLOCKED[readiness.state]
	if (blocked) return finish([], blocked)
	if (readiness.state === 'ready') return finish([])

	const hasImage = readiness.image.bundled !== undefined || manifest !== undefined
	const loadImage = (): WslcSetupStep => ({
		kind: 'load-image',
		elevated: false,
		...(manifest ? { diskBytes: manifest.sizeBytes } : {}),
		estimatedSeconds: manifest
			? LOAD_FIXED_SECONDS + Math.ceil(manifest.compressedBytes / LOAD_BYTES_PER_SECOND)
			: 60,
		mayRequireRestart: false,
	})
	const needImage = !readiness.image.loaded

	if (readiness.state === 'restart-pending') {
		const steps: WslcSetupStep[] = [
			{
				kind: 'restart',
				elevated: false,
				estimatedSeconds: RESTART_SECONDS,
				mayRequireRestart: true,
			},
		]
		if (needImage) {
			if (!hasImage) return finish([], 'image-unavailable')
			steps.push(loadImage())
		}
		return finish(steps)
	}

	const wslcVersion = readiness.wsl.wslcVersion
	const needWsl = wslcVersion === undefined || !wslcAtLeastMinimum(wslcVersion)
	const needFeatures =
		readiness.components.virtualMachinePlatform === false ||
		readiness.components.wslOptionalComponent === false

	if (needImage && !hasImage) return finish([], 'image-unavailable')

	const steps: WslcSetupStep[] = []
	if (needWsl)
		steps.push({
			kind: 'download-wsl',
			elevated: false,
			downloadBytes: pinned.sizeBytes,
			diskBytes: pinned.sizeBytes,
			estimatedSeconds: Math.ceil(pinned.sizeBytes / DOWNLOAD_BYTES_PER_SECOND),
			mayRequireRestart: false,
		})
	if (needFeatures)
		steps.push({
			kind: 'enable-windows-features',
			elevated: true,
			estimatedSeconds: ENABLE_FEATURES_SECONDS,
			mayRequireRestart: true,
		})
	if (needWsl)
		steps.push({
			kind: 'install-wsl',
			elevated: true,
			estimatedSeconds: INSTALL_WSL_SECONDS,
			mayRequireRestart: true,
		})
	if (needFeatures)
		steps.push({
			kind: 'restart',
			elevated: false,
			estimatedSeconds: RESTART_SECONDS,
			mayRequireRestart: true,
		})
	if (needImage) steps.push(loadImage())
	return finish(steps)
}
