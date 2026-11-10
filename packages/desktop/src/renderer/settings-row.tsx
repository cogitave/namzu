import type { ReactNode } from 'react'

/** One setting: its name and a line of help on the left, its control on the right. */
export function Row({
	id,
	label,
	description,
	children,
	stacked,
}: {
	id: string
	label: string
	description?: string
	children?: ReactNode
	stacked?: boolean
}) {
	const labelId = `setting-${id}-label`
	return (
		<div id={`setting-${id}`} className="settings-row" data-stacked={stacked || undefined}>
			<div className="settings-row-copy">
				<h3 id={labelId}>{label}</h3>
				{description && <p>{description}</p>}
			</div>
			{children && <div className="settings-row-control">{children}</div>}
		</div>
	)
}

export function Switch({
	label,
	checked,
	disabled,
	onChange,
}: {
	label: string
	checked: boolean
	disabled?: boolean
	onChange: (value: boolean) => void
}) {
	return (
		<input
			type="checkbox"
			role="switch"
			className="settings-switch"
			aria-label={label}
			aria-checked={checked}
			checked={checked}
			disabled={disabled}
			onChange={(event) => onChange(event.target.checked)}
		/>
	)
}
