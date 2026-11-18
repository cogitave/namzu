import { type ReactNode, useId } from 'react'
import type { IconComponent } from './icons.js'

/** One setting: its name and a line of help on the left, its control on the right. */
export function Row({
	id,
	label,
	description,
	meta,
	children,
	stacked,
	below,
	child,
	badge,
}: {
	id: string
	label: string
	description?: string
	/** A second line under the description: the default, and when a change applies. */
	meta?: string
	children?: ReactNode
	stacked?: boolean
	/** Full width under the row: a preview of what the control does. */
	below?: ReactNode
	/** A setting that only means something under the one above it: drawn indented. */
	child?: boolean
	/**
	 * A short mark beside the name, for a row that waits for a restart. The short text is what is
	 * drawn; the full sentence is its tooltip and its accessible name, so it is never ambiguous.
	 */
	badge?: { text: string; sentence: string }
}) {
	const labelId = `setting-${id}-label`
	return (
		<div
			id={`setting-${id}`}
			className="settings-row"
			data-stacked={stacked || undefined}
			data-below={below ? '' : undefined}
			data-child={child || undefined}
		>
			<div className="settings-row-copy">
				<h3 id={labelId}>
					{label}
					{badge && (
						<span
							className="settings-row-badge"
							title={badge.sentence}
							role="img"
							aria-label={badge.sentence}
						>
							{badge.text}
						</span>
					)}
				</h3>
				{description && <p>{description}</p>}
				{meta && <p data-settings-meta>{meta}</p>}
			</div>
			{children && <div className="settings-row-control">{children}</div>}
			{below && <div className="settings-row-below">{below}</div>}
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

/**
 * Two to four choices side by side, one of them chosen: a radio group drawn as one connected
 * control. The choice itself is the radio, so the keyboard and a screen reader work as for any
 * radio group. Used by the rows that pick one of a few named values.
 */
export function SegmentedControl<T extends string>({
	label,
	value,
	options,
	disabled,
	onChange,
}: {
	label: string
	value: T
	options: readonly { value: T; label: string; Icon?: IconComponent }[]
	disabled?: boolean
	onChange: (value: T) => void
}) {
	const group = useId()
	return (
		<fieldset className="settings-segmented" disabled={disabled}>
			<legend className="sr-only">{label}</legend>
			{options.map(({ value: choice, label: text, Icon }) => (
				<label key={choice} className="settings-segment">
					<input
						type="radio"
						name={group}
						value={choice}
						checked={value === choice}
						onChange={() => onChange(choice)}
					/>
					{Icon && <Icon aria-hidden="true" />}
					<span>{text}</span>
				</label>
			))}
		</fieldset>
	)
}

/** A drop-down in a row, one height with the other controls. */
export function SelectControl({
	label,
	value,
	disabled,
	onChange,
	children,
}: {
	label: string
	value: string
	disabled?: boolean
	onChange: (value: string) => void
	children: ReactNode
}) {
	return (
		<select
			className="settings-config-input settings-select"
			aria-label={label}
			value={value}
			disabled={disabled}
			onChange={(event) => onChange(event.target.value)}
		>
			{children}
		</select>
	)
}
