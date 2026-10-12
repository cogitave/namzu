/**
 * The contract of the Windows Pal computer setup: what a readiness inspection
 * reports, the plan a person consents to, and how running that plan reports
 * progress and ends. The provider never installs, updates, loads or starts
 * anything; everything here is a separate operation an application runs after
 * the person agrees.
 */
import type { LocalComputerCommandRunner } from '../engine.js'

/**
 * One state per machine, checked in this order: the first that applies wins.
 * - `unsupported`: not Windows, not x64, or a Windows build below 19041.
 * - `blocked-by-policy`: `AllowWSL` or `AllowWSLContainer` is 0 under
 *   `HKLM\Software\Policies\WSL`.
 * - `restart-pending`: setup recorded that Windows needs a restart, and the PC
 *   has not restarted since; or Virtual Machine Platform is on, no hypervisor
 *   runs yet, and Windows itself reports a restart pending (no marker then).
 *   A marker that cannot be read, or a boot time that cannot be fetched while
 *   a marker exists, also reads `restart-pending`: the steps still to run
 *   after the restart are then unknown and treated as none. So does a marker
 *   that can be neither read nor dated (no file date): `restart` is then
 *   absent, since there is no record time to report.
 * - `platform-off`: Virtual Machine Platform is off, or (Windows 10 only) the
 *   Windows Subsystem for Linux optional component is.
 * - `wsl-missing`: no WSL package with wslc.
 * - `wsl-outdated`: WSL is present, but wslc is missing or below the floor.
 * - `sdk-mismatch`: the installed WSL refuses this client (`0x8004060B`).
 * - `virtualization-off`: the session's virtual machine cannot start
 *   (`0x80370102`), or (without a session probe) no hypervisor runs although
 *   the platform is on and Windows reports no restart pending.
 * - `image-missing`: wslc works, but the Pal computer image is not loaded.
 * - `ready`: wslc works and the image is loaded and matches its manifest.
 */
export type WslcReadinessState =
	| 'unsupported'
	| 'blocked-by-policy'
	| 'restart-pending'
	| 'platform-off'
	| 'wsl-missing'
	| 'wsl-outdated'
	| 'sdk-mismatch'
	| 'virtualization-off'
	| 'image-missing'
	| 'ready'

/** Why a machine is `unsupported`. */
export type WslcUnsupportedReason = 'platform' | 'architecture' | 'windows-build'

/** What a readiness inspection found. Plain data; safe to print as JSON. */
export interface WslcReadiness {
	readonly state: WslcReadinessState
	/** Set only when `state` is `unsupported`. */
	readonly unsupportedReason?: WslcUnsupportedReason
	readonly windows?: {
		readonly build: number
		readonly architecture: 'x64' | 'arm64' | 'other'
		readonly isWindows11: boolean
	}
	readonly policy: {
		readonly allowWsl: boolean
		readonly allowWslContainer: boolean
	}
	readonly components: {
		readonly virtualMachinePlatform: boolean | 'unknown'
		/** Windows 11 does not need the optional component. */
		readonly wslOptionalComponent: boolean | 'unknown' | 'not-needed'
		readonly hypervisorPresent: boolean | 'unknown'
	}
	readonly wsl: {
		/** `x.y.z.w` from `wsl.exe --version`, when a WSL package answers. */
		readonly version?: string
		/** The wslc binary found, if any. */
		readonly wslcBinary?: string
		/** `x.y.z` from `wslc version`. */
		readonly wslcVersion?: string
	}
	readonly image: {
		/** The reference the inspection looked for, e.g. `namzu-local-computer:2`. */
		readonly ref: string
		readonly loaded: boolean
		/** A manifest and archive the application carries, if it has them. */
		readonly bundled?: { readonly manifestPath: string; readonly archivePath: string }
	}
	/** Set when setup recorded a required restart (see {@link WslcRestartMarker}). */
	readonly restart?: { readonly recordedAt: string; readonly bootTime?: string }
	/** ISO time of the inspection. */
	readonly checkedAt: string
}

/**
 * The image manifest `local-computer/build-image.mjs` writes and the Windows
 * installer carries in `resources/pal-computer/manifest.json`.
 */
export interface WslcImageManifest {
	readonly revision: number
	readonly stage: 'base' | 'creative'
	/** `namzu-local-computer:<revision>`; a test tag is never bundled. */
	readonly imageRef: string
	readonly imageId: string
	/** The image's `org.namzu.local-computer.protocol` label. */
	readonly protocol: string
	/** The archive's file name, beside the manifest. */
	readonly file: string
	/** SHA-256 of the archive as shipped. */
	readonly sha256: string
	/** SHA-256 of the uncompressed tar. */
	readonly tarSha256: string
	/** Size of the uncompressed tar. */
	readonly sizeBytes: number
	/** Size of the archive. */
	readonly compressedBytes: number
	readonly format: 'zst' | 'xz' | 'gz' | 'tar'
}

/** The WSL release setup installs when WSL is missing or too old. */
export interface PinnedWslPackage {
	/** `x.y.z.w`, for example `3.0.1.0`. */
	readonly version: string
	readonly architecture: 'x64'
	/** An `https://github.com/microsoft/WSL/releases/download/...` URL. */
	readonly url: string
	readonly sha256: string
	readonly sizeBytes: number
}

/**
 * One step of a plan, in the order it runs.
 * - `download-wsl`: fetch the pinned WSL package into the setup directory and
 *   check its size and SHA-256. Not elevated.
 * - `enable-windows-features`: turn on Virtual Machine Platform (and on
 *   Windows 10 the WSL optional component). Elevated.
 * - `install-wsl`: install the downloaded WSL package. Elevated.
 * - `restart`: the person restarts the PC; setup continues after sign-in.
 * - `load-image`: check the bundled archive against its manifest and load it
 *   with `wslc load -i`. Not elevated.
 *
 * Every elevated step of one plan runs in ONE elevated process, so a plan
 * causes at most one Windows permission prompt.
 */
export type WslcSetupStepKind =
	| 'download-wsl'
	| 'enable-windows-features'
	| 'install-wsl'
	| 'restart'
	| 'load-image'

export interface WslcSetupStep {
	readonly kind: WslcSetupStepKind
	readonly elevated: boolean
	/** Bytes this step downloads, if any. */
	readonly downloadBytes?: number
	/** Bytes this step adds on disk, if known. */
	readonly diskBytes?: number
	/** A rough duration for the sentence the person reads. */
	readonly estimatedSeconds: number
	readonly mayRequireRestart: boolean
}

/** Why a plan has nothing Namzu can do. */
export type WslcSetupBlock =
	| 'unsupported'
	| 'blocked-by-policy'
	| 'virtualization-off'
	| 'sdk-mismatch'
	/** No bundled image and no other way to get one. */
	| 'image-unavailable'

export interface WslcSetupPlan {
	/**
	 * A digest of the readiness state and the steps. Consent names it, and
	 * running refuses a plan whose id no longer matches a fresh inspection.
	 */
	readonly id: string
	readonly state: WslcReadinessState
	readonly steps: readonly WslcSetupStep[]
	/** 0 or 1: all elevated steps share one elevated process. */
	readonly elevationPrompts: 0 | 1
	readonly mayRequireRestart: boolean
	/** Set when setup cannot proceed; `steps` is then empty. */
	readonly blocked?: WslcSetupBlock
}

/** The person's agreement to one specific plan. */
export interface WslcSetupConsent {
	readonly planId: string
	/** ISO time of the click or the typed answer. */
	readonly approvedAt: string
}

/** Progress, emitted in order. Byte counts are raw; the caller humanises them. */
export type WslcSetupProgress =
	| { readonly step: WslcSetupStepKind; readonly phase: 'started' }
	| {
			readonly step: WslcSetupStepKind
			readonly phase: 'progress'
			readonly done: number
			readonly total?: number
			readonly unit: 'bytes' | 'percent'
	  }
	| {
			readonly step: WslcSetupStepKind
			readonly phase: 'finished'
			readonly result: 'ok' | 'restart-required'
	  }

/** Stable reasons a failed setup step carries. */
export type WslcSetupFailureCode =
	| 'download-failed'
	| 'download-corrupt'
	| 'elevation-failed'
	| 'feature-enable-failed'
	| 'wsl-install-failed'
	| 'image-corrupt'
	| 'image-load-failed'
	| 'image-mismatch'
	| 'engine-failed'

/** How running a plan ended. */
export type WslcSetupResult =
	| { readonly outcome: 'ready' }
	| { readonly outcome: 'restart-required' }
	/** The person declined the Windows permission prompt. */
	| { readonly outcome: 'cancelled' }
	/** The account cannot elevate and no administrator approved. */
	| { readonly outcome: 'needs-administrator' }
	/** The consent names a plan that no longer matches the machine. */
	| { readonly outcome: 'plan-changed'; readonly plan: WslcSetupPlan }
	| { readonly outcome: 'blocked'; readonly blocked: WslcSetupBlock }
	| {
			readonly outcome: 'failed'
			readonly step: WslcSetupStepKind
			readonly code: WslcSetupFailureCode
			/** Plain words for a Details fold. Never engine output or paths with user names. */
			readonly detail?: string
			/** The Windows exit code of the failed step, when Windows gave one. */
			readonly exitCode?: number
	  }

/**
 * Written to `<stateDirectory>/restart.json` when an elevated step reports
 * that Windows needs a restart; cleared once readiness sees a boot later than
 * `recordedAt`.
 */
export interface WslcRestartMarker {
	readonly recordedAt: string
	readonly planId: string
	/** Steps still to run after the restart. */
	readonly remaining: readonly WslcSetupStepKind[]
}

/** Exit status of the elevated process, before it is mapped to a result. */
export type WslcElevatedOutcome =
	| { readonly outcome: 'ok' }
	| { readonly outcome: 'restart-required' }
	| { readonly outcome: 'cancelled' }
	| { readonly outcome: 'needs-administrator' }
	| {
			readonly outcome: 'failed'
			readonly step: 'enable-windows-features' | 'install-wsl'
			readonly code: 'feature-enable-failed' | 'wsl-install-failed' | 'elevation-failed'
			/** The Windows exit code, for a Details fold. */
			readonly exitCode?: number
	  }

/**
 * Everything the setup touches on the machine, injected so tests can stand in
 * for Windows. Implementations for a real Windows host live beside the
 * functions that use them.
 */
export interface WslcSetupHost {
	readonly platform: NodeJS.Platform
	readonly arch: string
	/** Windows build number, e.g. 19045; undefined off Windows. */
	readonly windowsBuild: number | undefined
	readonly env: NodeJS.ProcessEnv
	readonly runner: LocalComputerCommandRunner
	/** A DWORD from the registry; undefined when the value or key is absent. */
	readDword(key: string, name: string): Promise<number | undefined>
	/** Whether a registry key exists; `unknown` when the check failed or timed out. */
	keyExists(key: string): Promise<boolean | 'unknown'>
	/** The last boot time of Windows. */
	bootTime(): Promise<Date>
	now(): Date
	/** `%LOCALAPPDATA%\Namzu\setup` unless the caller chooses otherwise. */
	readonly stateDirectory: string
	/**
	 * The registry key the resume command is written under. Defaults to
	 * {@link RESUME_AT_SIGN_IN_KEY}; a trial run on a real PC points it at a
	 * scratch key so nothing runs at the next sign-in.
	 */
	readonly resumeRegistryKey: string
}

/** Where Windows keeps the command it runs once at the next sign-in. */
export const RESUME_AT_SIGN_IN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce'

/** Options every setup entry point takes. */
export interface WslcSetupOptions {
	/** The image the application runs, e.g. `namzu-local-computer:2`. */
	readonly imageRef: string
	/** The manifest the application carries, with its archive beside it. */
	readonly bundledManifestPath?: string
	/** Defaults to the release pinned in this package. */
	readonly wslPackage?: PinnedWslPackage
	readonly host?: Partial<WslcSetupHost>
	readonly signal?: AbortSignal
	/**
	 * Start the wslc session to check the loaded image and the virtual machine
	 * itself. Off by default, so opening a panel never starts a virtual machine
	 * of about 2 GB; without it, `image.loaded` comes from the record setup
	 * writes after a successful load (`<stateDirectory>/image.json`).
	 * `runWslcSetup` always probes.
	 */
	readonly probeSession?: boolean
}

/** Run the one elevated process for the elevated steps of a plan. */
export type RunElevatedWslcSteps = (request: {
	readonly steps: readonly ('enable-windows-features' | 'install-wsl')[]
	/** Required when `install-wsl` is among the steps; re-verified while elevated. */
	readonly wslPackage?: { readonly path: string; readonly sha256: string }
	readonly host: WslcSetupHost
	readonly onProgress?: (progress: WslcSetupProgress) => void
	readonly signal?: AbortSignal
}) => Promise<WslcElevatedOutcome>

/** The entry points, as the CLI and Desktop call them. */
export type InspectWslcReadiness = (options: WslcSetupOptions) => Promise<WslcReadiness>
export type PlanWslcSetup = (
	readiness: WslcReadiness,
	options: Pick<WslcSetupOptions, 'wslPackage'> & { readonly manifest?: WslcImageManifest },
) => WslcSetupPlan
export type RunWslcSetup = (
	consent: WslcSetupConsent,
	options: WslcSetupOptions & {
		readonly onProgress?: (progress: WslcSetupProgress) => void
		/** Defaults to the real elevated runner; tests pass a stand-in. */
		readonly runElevated?: RunElevatedWslcSteps
		/** The command Windows runs once at the next sign-in to continue setup. */
		readonly resumeCommand?: string
	},
) => Promise<WslcSetupResult>
/**
 * Stop the wslc session's virtual machine when nothing runs in it. Answers
 * `busy` and does nothing while any container runs, Namzu's or not.
 */
export type StopIdleWslcSession = (
	options: Pick<WslcSetupOptions, 'host' | 'signal'>,
) => Promise<{ readonly outcome: 'stopped' | 'busy' | 'not-running' }>

/** Check the bundled archive against its manifest, load it, and check what loaded. */
export type LoadWslcImage = (options: {
	readonly manifestPath: string
	readonly host?: Partial<WslcSetupHost>
	readonly onProgress?: (progress: WslcSetupProgress) => void
	readonly signal?: AbortSignal
}) => Promise<
	| { readonly outcome: 'loaded' | 'already-loaded' }
	| {
			readonly outcome: 'failed'
			readonly code: 'image-corrupt' | 'image-load-failed' | 'image-mismatch'
			readonly detail?: string
	  }
>

/**
 * Fetch the pinned WSL package into `directory`, resuming a partial file, and
 * check its size and SHA-256. A file that fails the check is deleted.
 */
export type DownloadWslPackage = (options: {
	readonly pinned: PinnedWslPackage
	readonly directory: string
	readonly fetch?: typeof fetch
	readonly onProgress?: (progress: WslcSetupProgress) => void
	readonly signal?: AbortSignal
}) => Promise<
	| { readonly outcome: 'ok'; readonly path: string }
	| {
			readonly outcome: 'failed'
			readonly code: 'download-failed' | 'download-corrupt'
			readonly detail?: string
	  }
>

/** The restart marker in `<stateDirectory>/restart.json`. */
export type ReadRestartMarker = (host: WslcSetupHost) => Promise<WslcRestartMarker | undefined>
export type WriteRestartMarker = (host: WslcSetupHost, marker: WslcRestartMarker) => Promise<void>
export type ClearRestartMarker = (host: WslcSetupHost) => Promise<void>

/** Ask Windows to run `command` once at the next sign-in, and take that back. */
export type RegisterResumeAtSignIn = (host: WslcSetupHost, command: string) => Promise<void>
export type ClearResumeAtSignIn = (host: WslcSetupHost) => Promise<void>

/** The real Windows host, with `overrides` applied. */
export type CreateWslcSetupHost = (overrides?: Partial<WslcSetupHost>) => WslcSetupHost
