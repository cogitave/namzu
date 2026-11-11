import { palComputerImageSize } from '../shared/pal-computer-image.js'
import { GetDockerButton } from './get-docker-button.js'
import { MonitorIcon } from './icons.js'

/**
 * What the Pal computer page shows, once, where the live screen would be, when this PC lacks what the
 * computer runs on. With a stopped Podman machine the missing piece is starting it, so the card says
 * that and offers no download; otherwise it says what the computer is, what it needs and costs.
 */
export function PalComputerSetupCard({
	palName,
	podmanStopped,
}: {
	palName: string
	podmanStopped?: boolean
}) {
	return (
		<section
			className="pal-computer-empty pal-computer-setup-card"
			aria-labelledby="pal-computer-setup-title"
			data-setup-card
		>
			<MonitorIcon />
			{podmanStopped ? (
				<>
					<h3 id="pal-computer-setup-title">Start your Podman machine</h3>
					<p>
						{palName}’s computer runs on Podman, and its machine is not running. Start it from
						Podman, then come back here.
					</p>
				</>
			) : (
				<>
					<h3 id="pal-computer-setup-title">Set up {palName}’s computer</h3>
					<p>A private desktop where {palName} can open apps and files, kept apart from yours.</p>
					<p>
						It needs Docker Desktop or Podman, and{' '}
						{palComputerImageSize().replace(' GB', '\u00a0GB')} of disk for the computer image.
					</p>
					<GetDockerButton />
				</>
			)}
			<p>Chatting works without it. Namzu checks again when you come back here.</p>
		</section>
	)
}
