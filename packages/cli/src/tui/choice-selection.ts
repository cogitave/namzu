import type { ChoicePickerOption } from './ChoicePicker.js'
import { SELECTION_WINDOW_SIZE, type SelectionMovement, moveSelection } from './selection-window.js'

/** Keep option identity and source order so filtering cannot change the applied value. */
export function filterChoiceOptions<T extends ChoicePickerOption>(
	options: readonly T[],
	query: string,
): readonly T[] {
	const words = query.normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean)
	if (words.length === 0) return options
	return options.filter((option) => {
		const text = [option.label, option.description, option.searchText ?? '']
			.join(' ')
			.normalize('NFKC')
			.toLowerCase()
		return words.every((word) => text.includes(word))
	})
}

/** Disabled rows remain discoverable, but keyboard navigation never applies them. */
export function moveChoiceSelection(
	options: readonly ChoicePickerOption[],
	selected: number,
	movement: SelectionMovement,
	pageSize = SELECTION_WINDOW_SIZE,
): number {
	const candidate = moveSelection(selected, options.length, movement, pageSize)
	const direction =
		movement === 'previous' || movement === 'previous-page' || movement === 'last' ? -1 : 1
	for (let index = candidate; index >= 0 && index < options.length; index += direction) {
		if (!options[index]?.disabledReason) return index
	}
	// At a disabled boundary keep the closest available row, including the
	// current one; an all-disabled result has no actionable cursor.
	for (
		let index = candidate - direction;
		index >= 0 && index < options.length;
		index -= direction
	) {
		if (!options[index]?.disabledReason) return index
	}
	return -1
}

export interface ChoicePickerGeometry {
	readonly rows?: number
	readonly columns?: number
	readonly searchable?: boolean
	readonly notice?: boolean
	readonly selectedDescription?: boolean
	readonly windowSize?: number
}

/** Reserve room for App's header/footer and the chooser's own non-list rows. */
export function choicePickerWindowSize({
	rows = 24,
	columns = 80,
	searchable = false,
	notice = false,
	selectedDescription = false,
	windowSize = SELECTION_WINDOW_SIZE,
}: ChoicePickerGeometry): number {
	const availableRows = Math.max(6, rows - 4)
	const furnitureRows = 4 + Number(searchable) + Number(notice) + Number(selectedDescription)
	const rowHeight = columns < 70 ? 2 : 1
	return Math.max(1, Math.min(windowSize, Math.floor((availableRows - furnitureRows) / rowHeight)))
}
