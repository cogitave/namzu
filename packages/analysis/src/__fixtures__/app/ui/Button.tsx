import { useState } from 'react'

export function Button(props: { label: string }) {
	const [n, setN] = useState(0)
	return <button title="Click to count" onClick={() => setN(n + 1)}>{props.label}: {n}</button>
}
