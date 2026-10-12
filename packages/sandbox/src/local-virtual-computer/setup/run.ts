import type {
	RunWslcSetup,
	WslcImageManifest,
	WslcSetupFailureCode,
	WslcSetupProgress,
	WslcSetupResult,
	WslcSetupStepKind,
} from './contract.js'
import { runElevatedWslcSteps } from './elevated.js'
import { createWslcSetupHost } from './host.js'
import { loadWslcImage } from './image.js'
import { planWslcSetup } from './plan.js'
import { inspectWslcReadiness } from './readiness.js'
import { clearRestartMarker, readRestartMarker, writeRestartMarker } from './restart.js'
import { clearResumeAtSignIn, registerResumeAtSignIn } from './resume.js'
import { PINNED_WSL_PACKAGE, downloadWslPackage } from './wsl-package.js'
import { readManifest, writeImageRecord } from './wslc-shared.js'

type Elevated = 'enable-windows-features' | 'install-wsl'

const isElevated = (kind: WslcSetupStepKind): kind is Elevated =>
	kind === 'enable-windows-features' || kind === 'install-wsl'

const ELEVATED_WORDS: Record<Elevated, string> = {
	'enable-windows-features': 'Turning on Windows features',
	'install-wsl': 'Installing Linux support',
}

const elevatedFailureDetail = (step: WslcSetupStepKind, exitCode?: number): string => {
	const words = isElevated(step) ? ELEVATED_WORDS[step] : 'This step'
	return exitCode === undefined
		? `${words} did not finish.`
		: `${words} stopped with exit code ${exitCode}.`
}

/**
 * Run the plan the person agreed to. Inspects again first, with the session
 * probe, and refuses with `plan-changed` when the plan it would run is not the
 * one named by the consent.
 */
export const runWslcSetup: RunWslcSetup = async (consent, options) => {
	const host = createWslcSetupHost(options.host)
	const { signal } = options
	const pinned = options.wslPackage ?? PINNED_WSL_PACKAGE
	const inspectOptions = { ...options, host, probeSession: true }

	const markerBefore = await readRestartMarker(host)
	const readiness = await inspectWslcReadiness(inspectOptions)
	let manifest: WslcImageManifest | undefined
	if (readiness.image.bundled) {
		try {
			manifest = await readManifest(readiness.image.bundled.manifestPath)
		} catch {
			manifest = undefined
		}
	}
	const plan = planWslcSetup(readiness, { wslPackage: options.wslPackage, manifest })
	if (plan.id !== consent.planId) {
		// The PC is already ready (for example the image was loaded before Namzu kept a record of
		// it): nothing is left to do, but the next quiet status must say so, so record it now.
		if (readiness.state === 'ready' && manifest) {
			await writeImageRecord(host, {
				imageRef: manifest.imageRef,
				imageId: manifest.imageId,
				loadedAt: host.now().toISOString(),
			})
			return { outcome: 'ready' }
		}
		return { outcome: 'plan-changed', plan }
	}
	if (plan.blocked) return { outcome: 'blocked', blocked: plan.blocked }

	// Each step reports started and finished once, whoever emits it.
	const announced = new Set<string>()
	const emit = (progress: WslcSetupProgress): void => {
		if (progress.phase !== 'progress') {
			const key = `${progress.step}:${progress.phase}`
			if (announced.has(key)) return
			announced.add(key)
		}
		options.onProgress?.(progress)
	}
	const started = (step: WslcSetupStepKind): void => emit({ step, phase: 'started' })
	const finished = (step: WslcSetupStepKind, result: 'ok' | 'restart-required'): void =>
		emit({ step, phase: 'finished', result })
	const failed = (
		step: WslcSetupStepKind,
		code: WslcSetupFailureCode,
		detail?: string,
		exitCode?: number,
	): WslcSetupResult => ({
		outcome: 'failed',
		step,
		code,
		...(detail ? { detail } : {}),
		...(exitCode === undefined ? {} : { exitCode }),
	})

	const kinds = plan.steps.map((step) => step.kind)
	let packagePath: string | undefined
	let elevatedOk = false

	for (const step of plan.steps) {
		if (step.kind === 'restart') {
			// Windows said the elevated steps need no restart: nothing to wait for.
			if (elevatedOk) continue
			return { outcome: 'restart-required' }
		}
		if (step.kind === 'download-wsl') {
			started('download-wsl')
			const downloaded = await downloadWslPackage({
				pinned,
				directory: host.stateDirectory,
				onProgress: emit,
				signal,
			})
			if (downloaded.outcome === 'failed')
				return failed('download-wsl', downloaded.code, downloaded.detail)
			packagePath = downloaded.path
			finished('download-wsl', 'ok')
		}
		if (isElevated(step.kind)) {
			// All elevated steps share one call, made at the first of them.
			if (step.kind !== kinds.find(isElevated)) continue
			const elevated = kinds.filter(isElevated)
			// Only the first step is announced now; the tail of the elevated progress file announces
			// each later one when the script reaches it, so a failure never shows a step that did not start.
			started(elevated[0] as Elevated)
			const outcome = await (options.runElevated ?? runElevatedWslcSteps)({
				steps: elevated,
				...(elevated.includes('install-wsl') && packagePath
					? { wslPackage: { path: packagePath, sha256: pinned.sha256 } }
					: {}),
				host,
				onProgress: emit,
				signal,
			})
			switch (outcome.outcome) {
				case 'cancelled':
					return { outcome: 'cancelled' }
				case 'needs-administrator':
					return { outcome: 'needs-administrator' }
				case 'failed':
					return failed(
						outcome.step,
						outcome.code,
						elevatedFailureDetail(outcome.step, outcome.exitCode),
						outcome.exitCode,
					)
				case 'restart-required': {
					const last = elevated[elevated.length - 1] as Elevated
					for (const kind of elevated) {
						started(kind)
						finished(kind, kind === last ? 'restart-required' : 'ok')
					}
					const after = kinds.slice(kinds.lastIndexOf(last) + 1)
					await writeRestartMarker(host, {
						recordedAt: host.now().toISOString(),
						planId: plan.id,
						remaining: after.filter((kind) => kind !== 'restart'),
					})
					if (options.resumeCommand) await registerResumeAtSignIn(host, options.resumeCommand)
					return { outcome: 'restart-required' }
				}
				case 'ok':
					for (const kind of elevated) {
						started(kind)
						finished(kind, 'ok')
					}
					elevatedOk = true
					break
			}
		}
		if (step.kind === 'load-image') {
			if (!readiness.image.bundled) return { outcome: 'blocked', blocked: 'image-unavailable' }
			started('load-image')
			const loaded = await loadWslcImage({
				manifestPath: readiness.image.bundled.manifestPath,
				host,
				onProgress: emit,
				signal,
			})
			if (loaded.outcome === 'failed') return failed('load-image', loaded.code, loaded.detail)
			finished('load-image', 'ok')
		}
	}

	const after = await inspectWslcReadiness(inspectOptions)
	switch (after.state) {
		case 'ready':
			if (markerBefore !== undefined) {
				await clearRestartMarker(host)
				try {
					await clearResumeAtSignIn(host)
				} catch {
					// The resume entry is a convenience; a leftover one is harmless.
				}
			}
			return { outcome: 'ready' }
		case 'restart-pending':
			return { outcome: 'restart-required' }
		case 'virtualization-off':
		case 'sdk-mismatch':
		case 'blocked-by-policy':
		case 'unsupported':
			return { outcome: 'blocked', blocked: after.state }
		default:
			return failed(
				plan.steps[plan.steps.length - 1]?.kind ?? 'load-image',
				'engine-failed',
				'Setup finished, but the Pal computer is still not ready on this PC.',
			)
	}
}
