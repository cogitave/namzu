import type { ResidentDeliveryGate } from './outbox.js'

/** @experimental A daily allowed delivery window in an explicit named time zone. */
export interface ResidentDeliveryWindowConfig {
	readonly timeZone: string
	/** Inclusive local minute of the day, from 0 through 1439. */
	readonly startMinute: number
	/** Exclusive local minute of the day; less than startMinute means overnight. */
	readonly endMinute: number
}

const minuteMs = 60_000
const searchMinutes = 72 * 60

/**
 * @experimental Admit delivery within a daily local-time window, without model
 * calls. The start is inclusive and the end exclusive; equal boundaries are
 * rejected. Omit this gate when no time restriction is wanted.
 *
 * Future admission searches actual UTC minute boundaries, so nonexistent local
 * times are skipped and repeated times can open the window twice. The search
 * is bounded to 72 hours and the Date range; no opening returns nextCheckAt:null.
 * Historic time zones with second-based offsets may defer up to one extra minute.
 * This gate does not schedule a timer, authorize a destination or send a message.
 */
export function createResidentDeliveryWindow(
	config: ResidentDeliveryWindowConfig,
): ResidentDeliveryGate {
	if (
		!config ||
		typeof config.timeZone !== 'string' ||
		config.timeZone.length === 0 ||
		config.timeZone !== config.timeZone.trim() ||
		/^[+-]/.test(config.timeZone) ||
		!Number.isInteger(config.startMinute) ||
		config.startMinute < 0 ||
		config.startMinute > 1439 ||
		!Number.isInteger(config.endMinute) ||
		config.endMinute < 0 ||
		config.endMinute > 1439 ||
		config.startMinute === config.endMinute
	) {
		throw new TypeError('Delivery window requires a named time zone and distinct minutes 0–1439.')
	}

	let formatter: Intl.DateTimeFormat
	try {
		formatter = new Intl.DateTimeFormat('en-US', {
			timeZone: config.timeZone,
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		})
	} catch {
		throw new TypeError('Delivery window requires a valid named time zone.')
	}
	const { startMinute, endMinute } = config
	const timeZone = formatter.resolvedOptions().timeZone
	const allowed = (at: number): boolean => {
		const parts = formatter.formatToParts(at)
		const hour = Number(parts.find((part) => part.type === 'hour')?.value)
		const minute = Number(parts.find((part) => part.type === 'minute')?.value)
		const localMinute = hour * 60 + minute
		return startMinute < endMinute
			? localMinute >= startMinute && localMinute < endMinute
			: localMinute >= startMinute || localMinute < endMinute
	}

	return (_message, now) => {
		if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) {
			throw new TypeError('Delivery window requires a finite timestamp within the Date range.')
		}
		if (allowed(now)) return { allow: true }

		const firstMinute = (Math.floor(now / minuteMs) + 1) * minuteMs
		for (let offset = 0; offset < searchMinutes; offset++) {
			const candidate = firstMinute + offset * minuteMs
			if (!Number.isFinite(new Date(candidate).getTime())) break
			if (allowed(candidate)) {
				return {
					allow: false,
					nextCheckAt: candidate,
					reason: `Outside the allowed daily delivery window in ${timeZone}.`,
				}
			}
		}
		return {
			allow: false,
			nextCheckAt: null,
			reason: `No allowed delivery minute found within the next 72 hours and Date range in ${timeZone}.`,
		}
	}
}
