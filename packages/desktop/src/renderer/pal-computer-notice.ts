/**
 * What a person reads when a Pal's computer cannot start. The host reports the missing piece in
 * developer terms (a Dockerfile path, an image tag, an engine flag); the person needs to know what
 * is missing and how to get it, so those messages are replaced here and never shown.
 */
export const COMPUTER_SETUP_NOTICE =
	'A Pal’s computer needs Docker Desktop or Podman, with the Namzu computer image added. Install Docker Desktop, add the image (see “Local Pal computers” in the Namzu docs), then start your Pal again. Chatting works without a computer.'

const SETUP =
	/local (?:docker|podman)[^.]*required|image is not installed|dockerfile|namzu-local-computer|local pal computer image|rebuild the shipped|docker did not provide|current docker context|containers|container engine/i
const PODMAN_STOPPED =
	/podman machine[^.]*(?:stopped|unavailable|start)|machine pipe is unavailable/i
const NOT_LOCAL =
	/remote engines are refused|local unix socket|registered (?:locally|machine)|operator profile|arbitrary engine endpoint|requires an existing|select an existing podman/i
const DEVELOPER_DETAIL =
	/packages[\\/]|\.ts\b|\bnode_modules\b|[A-Za-z]:\\|(?:^|\s)\/(?:usr|home|var|opt)\//i

export function presentComputerNotice(raw: string | undefined): string | undefined {
	const text = raw?.trim()
	if (!text) return undefined
	if (PODMAN_STOPPED.test(text))
		return 'Your Podman machine is not running. Start it, then start your Pal again.'
	if (SETUP.test(text)) return COMPUTER_SETUP_NOTICE
	if (NOT_LOCAL.test(text))
		return 'A Pal’s computer can only use Docker or Podman running on this computer. Check that it is set up and running, then start your Pal again.'
	if (DEVELOPER_DETAIL.test(text))
		return 'The computer could not start. Check that Docker or Podman is running, then start your Pal again.'
	return text
}

/**
 * Whether the notice means this computer lacks what a Pal's computer runs on (the container engine
 * or its image, or a stopped Podman machine), so starting cannot work until the person sets it up.
 */
export function computerSetupMissing(raw: string | undefined): boolean {
	const text = raw?.trim()
	if (!text) return false
	return PODMAN_STOPPED.test(text) || SETUP.test(text) || NOT_LOCAL.test(text)
}

/** One plain sentence for what is missing, shown beside a Start that is switched off. */
export function computerMissingSentence(name: string, raw: string | undefined): string {
	return raw && PODMAN_STOPPED.test(raw)
		? `${name}’s computer cannot start: your Podman machine is not running.`
		: `${name}’s computer cannot start yet: it needs Docker Desktop or Podman, and neither is ready on this computer.`
}
