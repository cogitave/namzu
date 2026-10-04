/** Same two-row lettering as the operator CLI; no renderer dependency on the CLI. */
const lettering = '█▄ █ ▄▀█ █▀▄▀█ ▀█ █ █\n█ ▀█ █▀█ █ ▀ █ █▄ █▄█'
const initial = lettering
	.split('\n')
	.map((row) => row.slice(0, 4))
	.join('\n')

/** The first letter of the canonical wordmark, for compact identity slots. */
export function WordmarkInitial() {
	return (
		<pre className="namzu-wordmark initial" role="img" aria-label="Namzu">
			{initial}
		</pre>
	)
}

export function Wordmark({ hero = false }: { hero?: boolean }) {
	return (
		<pre className={`namzu-wordmark${hero ? ' hero' : ''}`} role="img" aria-label="Namzu">
			{lettering}
		</pre>
	)
}
