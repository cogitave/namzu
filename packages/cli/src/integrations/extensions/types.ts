/** One text in every language the package carries: `{ "<locale tag>": "words" }`. */
export type Localized = Readonly<Record<string, string>>

export type PermissionLevel = 'low' | 'medium' | 'high'

export interface ManifestPurpose {
	readonly id: string
	readonly text: Localized
}

export interface ManifestPermission {
	readonly id: string
	readonly level: PermissionLevel
	readonly optional: boolean
	/** True when the permission lets the extension see data about the person (rule B3 checks Namzu's own ids). */
	readonly personalData: boolean
	readonly summary: Localized
	readonly purposes: readonly ManifestPurpose[]
	readonly prompt?: Localized
}

export interface ManifestField {
	readonly name: string
	readonly type: 'integer' | 'text' | 'timestamp'
	readonly description: Localized
}

export interface ManifestDataKind {
	readonly id: string
	readonly from: readonly string[]
	readonly description: Localized
	readonly grain: 'minute' | 'event'
	readonly fields: readonly ManifestField[]
	/** Days the data is kept, or `keep`: kept until the organisation deletes it. */
	readonly retentionDays: number | 'keep'
	readonly leavesMachine: false
}

export interface ManifestCommand {
	readonly exe: string
	readonly args?: readonly string[]
}

export interface ManifestAction {
	readonly id: string
	readonly paramsSchema: string
	readonly schema: string
	readonly maxBytes: number
	readonly purpose: Localized
	readonly changes: 'view' | 'own-settings' | 'own-data-delete'
	readonly needsGesture?: boolean
}

export interface ManifestQuery {
	readonly id: string
	readonly returns: readonly string[]
	readonly schema: string
	readonly maxBytes: number
	readonly purpose: Localized
}

export interface ManifestSetting {
	readonly key: string
	readonly type: 'secret' | 'toggle' | 'number' | 'text'
	readonly perProvider?: boolean
	readonly label: Localized
	readonly purpose: Localized
	readonly usedBy?: 'none'
	readonly storage?: 'hostKeysFile'
}

export interface ManifestPage {
	readonly id: string
	readonly title: Localized
	readonly location: 'desktop.settings'
	readonly view: 'builtin:what-is-collected'
	readonly source: { readonly kind: 'privacy'; readonly counts: string }
}

export type IndicatorLocation = 'desktop.tray' | 'desktop.titlebar' | 'cli.statusline'

export interface ManifestIndicator {
	readonly id: string
	readonly locations: readonly IndicatorLocation[]
	readonly alwaysVisibleWhenRunning: true
	readonly states: {
		readonly collecting: { readonly label: Localized }
		readonly degraded?: { readonly label: Localized }
	}
}

export interface ManifestNotice {
	readonly file: string
	readonly sha256: string
}

export type NetworkUse = 'license' | 'ui' | 'process'

export interface ManifestNetworkHost {
	readonly host: string
	readonly purpose: Localized
	readonly for: readonly NetworkUse[]
}

export type ManifestNetwork =
	| { readonly mode: 'none' }
	| {
			readonly mode: 'declared'
			readonly hosts: readonly ManifestNetworkHost[]
	  }

export type LicenseClaim = 'customer' | 'seats' | 'expires' | 'features'
export type LicenseSend =
	| 'licenseKey'
	| 'machineHash'
	| 'extensionId'
	| 'extensionVersion'
	| 'hostVersion'

export interface ManifestLicenseVerifier {
	readonly type: 'ed25519-offline'
	readonly keyId: string
	readonly keyFile: string
}

export type ManifestLicensing =
	| { readonly kind: 'none' }
	| {
			readonly kind: 'key'
			readonly required: boolean
			readonly verifier: ManifestLicenseVerifier
			readonly claims: readonly LicenseClaim[]
			readonly onInvalid: 'disableAndExplain'
			readonly graceDays: number
	  }
	| {
			readonly kind: 'service'
			readonly required: boolean
			readonly claims: readonly LicenseClaim[]
			readonly onInvalid: 'disableAndExplain'
			readonly service: {
				readonly protocol: 'namzu-license/1'
				readonly baseUrl: string
				readonly verifier: ManifestLicenseVerifier
				readonly refreshHours: number
				readonly offlineGraceDays: number
				readonly sends: readonly LicenseSend[]
				readonly releaseOnRemove: boolean
			}
	  }

export type BackgroundIndicator =
	| { readonly kind: 'tray'; readonly label: Localized }
	| { readonly kind: 'none' }

export interface ManifestBackground {
	readonly runAt: 'signin'
	readonly permission: 'background.signin'
	readonly defaultOn: boolean
	readonly indicator: BackgroundIndicator
}

export type UiSlot = 'sidebar' | 'settings' | 'panel'
export type HostBridgeMethod = 'theme' | 'locale' | 'state' | 'openNamzu'

export interface ManifestUiPage {
	readonly id: string
	readonly title: Localized
	readonly slot: UiSlot
	readonly entry: string
	readonly icon?: string
	readonly minHeight?: number
	readonly usesNetwork?: boolean
	readonly bridge: {
		readonly allow: readonly string[]
		readonly host?: readonly HostBridgeMethod[]
	}
}

export interface ManifestChipState {
	readonly label: Localized
	readonly icon?: string
	readonly tone: 'ok' | 'info' | 'warn'
	readonly showCount?: boolean
}

export interface ManifestUiChip {
	readonly id: string
	readonly states: Readonly<Record<string, ManifestChipState>>
	readonly opens?: string
}

export interface ManifestUi {
	readonly icon: string
	readonly accent: string
	readonly pages?: readonly ManifestUiPage[]
	readonly chips?: readonly ManifestUiChip[]
}

export interface Manifest {
	readonly manifestVersion: 1
	readonly id: string
	readonly defaultLocale: string
	readonly locales: readonly string[]
	readonly name: Localized
	readonly description: Localized
	readonly version: string
	readonly publisher: {
		readonly id: string
		readonly name: string
		readonly homepage?: string
		readonly contact: string
	}
	readonly license: string
	readonly engines: {
		readonly namzu: string
		readonly desktop?: string
		readonly extensionApi: '1'
	}
	readonly platforms: readonly string[]
	readonly entry: {
		readonly process: {
			readonly id: string
			readonly command: Readonly<Record<string, ManifestCommand>>
			readonly cwd: '${extensionDir}'
			readonly env?: Readonly<Record<string, string>>
			readonly scope: 'per-user-session'
			readonly start: 'onEnable'
			readonly restart: {
				readonly policy: 'onFailure' | 'never'
				readonly backoffMs: readonly number[]
				readonly maxPerHour: number
				readonly stableAfterMs: number
			}
			readonly stopGraceMs: number
		}
		readonly maintenance?: {
			readonly command: Readonly<Record<string, ManifestCommand>>
			readonly runWhen: readonly ('hostStart' | 'daily' | 'onDisable' | 'onLicenseExpired')[]
			readonly timeoutMs?: number
		}
	}
	readonly contributes: {
		readonly endpoint: {
			readonly protocol: 'namzu-ext-query/1' | 'namzu-ext-query/2'
			readonly name: string
			readonly queries: readonly ManifestQuery[]
			readonly actions?: readonly ManifestAction[]
		}
		readonly settings?: readonly ManifestSetting[]
		readonly pages: readonly ManifestPage[]
		readonly indicator: ManifestIndicator
	}
	readonly permissions: readonly ManifestPermission[]
	readonly network: ManifestNetwork
	readonly background?: ManifestBackground
	readonly ui?: ManifestUi
	readonly files: readonly {
		readonly path: '${dataDir}'
		readonly access: 'readWrite'
		readonly purpose: Localized
	}[]
	readonly produces: readonly ManifestDataKind[]
	readonly privacy: {
		readonly doesNotCollect: readonly Localized[]
		readonly doesNotDo: readonly Localized[]
		readonly storage: {
			readonly where: Localized
			readonly encryption: Localized
			readonly adminCanRead: boolean
		}
		readonly leavesTheMachine: 'nothing' | 'licence-check-only' | 'declared'
		readonly controller: Localized
		readonly rights: { readonly view: true; readonly delete: Localized }
		readonly monitoringKind: 'none' | 'employee-activity' | 'device'
	}
	readonly legal: {
		readonly noticeVersion: string
		readonly notices: Readonly<Record<string, ManifestNotice>>
		readonly acknowledgement: {
			readonly mode: 'inform' | 'inform-and-acknowledge'
			readonly retainDays: number
		}
		readonly jurisdictions: readonly string[]
	}
	readonly licensing: ManifestLicensing
	readonly resources: {
		readonly maxMemoryMB: number
		readonly cpuSharePercent: number
		readonly maxDiskMB: number
		readonly onExceed: 'report' | 'stop'
		readonly enforcement: 'report'
	}
	readonly updates: {
		readonly channel: string
		readonly permissionChange: 'askAgain'
		readonly autoUpdate: 'never'
	}
	readonly signing: {
		readonly publisherKeyId: string
		readonly manifestSignature: 'signatures/manifest.sig'
		readonly files: 'files.sha256.json'
		readonly platformSignatures?: { readonly win32?: 'authenticode' }
	}
}

/** One refused thing: the rule that refused it, where, and the fix, in plain words. */
export interface ManifestIssue {
	readonly rule: string
	readonly path: string
	readonly message: string
}
