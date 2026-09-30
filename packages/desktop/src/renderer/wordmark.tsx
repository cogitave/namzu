/** Same two-row lettering as the operator CLI; no renderer dependency on the CLI. */
const lettering = '█▄ █ ▄▀█ █▀▄▀█ ▀█ █ █\n█ ▀█ █▀█ █ ▀ █ █▄ █▄█'

export function Wordmark({ hero = false }: { hero?: boolean }) {
	return (
		<pre className={`namzu-wordmark${hero ? ' hero' : ''}`} role="img" aria-label="Namzu">
			{lettering}
		</pre>
	)
}
