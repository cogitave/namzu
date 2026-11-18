import type { CatalogueOption } from '../shared/settings-catalogue.js'
import { useInstalledFonts } from './installed-fonts.js'
import { SelectControl } from './settings-row.js'

/**
 * A font picker: the named choices first, then the fonts installed on this computer once the
 * person asks for the list (a button, because the engine only lists fonts after a click). A
 * stored font that is not in the list stays in it, so the box never shows a choice it does not hold.
 */
export function FontChoice({
	label,
	value,
	named,
	familyValue,
	familyOf,
	onChange,
}: {
	label: string
	value: string
	/** The choices that are not an installed font, in the order shown. */
	named: readonly CatalogueOption[]
	/** The stored value for an installed font's name. */
	familyValue: (family: string) => string
	/** The font name inside a stored value, if it holds one. */
	familyOf: (value: string) => string | undefined
	onChange: (value: string) => void
}) {
	const [state, load] = useInstalledFonts()
	const current = familyOf(value)
	const families = state.status === 'ready' ? state.families : []
	const listed = current === undefined || families.includes(current)
	return (
		<div className="settings-font-choice">
			<SelectControl label={label} value={value} onChange={onChange}>
				{named.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
				{current !== undefined && !listed && <option value={value}>{current}</option>}
				{families.length > 0 && (
					<optgroup label="Installed on this computer">
						{families.map((family) => (
							<option key={family} value={familyValue(family)}>
								{family}
							</option>
						))}
					</optgroup>
				)}
			</SelectControl>
			{(state.status === 'idle' || state.status === 'loading') && (
				<button
					type="button"
					className="settings-font-find"
					disabled={state.status === 'loading'}
					onClick={load}
				>
					{state.status === 'loading' ? 'Looking…' : 'Find installed fonts'}
				</button>
			)}
		</div>
	)
}
