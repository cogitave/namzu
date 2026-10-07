import {
	type ComposerPermissionEngine,
	type ComposerPermissionMode,
	ComposerPermissions,
} from './composer-permissions.js'
import './composer-settings.css'

export { ComposerPermissions }
export type { ComposerPermissionEngine, ComposerPermissionMode }

/** Controlled per-conversation permissions in the Pal's message settings. */
export function ComposerSettings({
	permissionMode,
	disabled,
	onPermissionModeChange,
	reviewModes,
	engine,
	permissionScope,
}: {
	permissionMode: ComposerPermissionMode
	disabled: boolean
	onPermissionModeChange: (mode: ComposerPermissionMode) => void
	reviewModes?: readonly ComposerPermissionMode[]
	engine?: ComposerPermissionEngine
	permissionScope?: string
}) {
	return (
		<ComposerPermissions
			engine={engine}
			permissionScope={permissionScope}
			reviewModes={reviewModes}
			permissionMode={permissionMode}
			disabled={disabled}
			onChange={onPermissionModeChange}
		/>
	)
}
