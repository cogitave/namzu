import { DOCKER_DESKTOP_URL } from './pal-computer-notice.js'
import { Button } from './ui/button.js'

/** Opens Docker Desktop's page in the browser; absent where the app cannot open links. */
export function GetDockerButton() {
	if (typeof window === 'undefined' || !window.namzu?.openExternal) return null
	return (
		<Button
			variant="outline"
			size="xs"
			onClick={() => void window.namzu?.openExternal?.(DOCKER_DESKTOP_URL).catch(() => {})}
		>
			Get Docker Desktop
		</Button>
	)
}
