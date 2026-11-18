import { useEffect, useRef, useState } from 'react'
import { acceleratorFromPress } from '../shared/shortcuts.js'
import { Button } from './ui/button.js'

/**
 * A box that records a key combination. Press it, then press the keys; Escape cancels. A combination
 * needs a key and at least one of Ctrl, Alt or the Windows/Command key. Clear removes the shortcut.
 */
export function ShortcutBox({
	label,
	value,
	emptyText,
	disabled,
	onChange,
}: {
	label: string
	value: string
	/** What the box says while no shortcut is set. */
	emptyText: string
	disabled?: boolean
	onChange: (value: string) => void
}) {
	const [recording, setRecording] = useState(false)
	const box = useRef<HTMLButtonElement>(null)
	useEffect(() => {
		if (!recording) return
		const onKey = (event: KeyboardEvent) => {
			event.preventDefault()
			event.stopPropagation()
			if (event.code === 'Escape') {
				setRecording(false)
				box.current?.focus()
				return
			}
			const pressed = acceleratorFromPress(event)
			if (!pressed) return
			setRecording(false)
			box.current?.focus()
			if (pressed !== value) onChange(pressed)
		}
		window.addEventListener('keydown', onKey, true)
		return () => window.removeEventListener('keydown', onKey, true)
	}, [recording, value, onChange])
	return (
		<span className="settings-shortcut">
			<button
				ref={box}
				type="button"
				className="settings-config-input settings-shortcut-box"
				aria-label={`${label}: ${value || emptyText}. Press to change.`}
				data-recording={recording || undefined}
				disabled={disabled}
				onClick={() => setRecording(true)}
				onBlur={() => setRecording(false)}
			>
				{recording ? 'Press the keys…' : value || emptyText}
			</button>
			{value && (
				<Button
					type="button"
					size="sm"
					variant="ghost"
					aria-label={`Clear ${label}`}
					disabled={disabled}
					onClick={() => onChange('')}
				>
					Clear
				</Button>
			)}
		</span>
	)
}
