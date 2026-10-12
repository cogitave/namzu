import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ComputerPlan } from './pal-computer-lines.js'

/**
 * What the person agreed to, kept by Desktop: the steps of the plan they accepted and when. After
 * a restart Desktop goes on by itself only with steps already in this record.
 */
export interface ConsentRecord {
	steps: string[]
	at: string
	palId?: string
}

/**
 * Desktop may continue without asking again when every step of the new plan was agreed to and none
 * of them asks Windows' permission or downloads anything: that is the rest of what the person
 * accepted, not something new.
 */
export function canAutoContinue(record: ConsentRecord | undefined, plan: ComputerPlan): boolean {
	if (!record || plan.blocked || plan.steps.length === 0) return false
	const agreed = new Set(record.steps)
	return plan.steps.every(
		(step) => agreed.has(step.kind) && !step.elevated && (step.downloadBytes ?? 0) === 0,
	)
}

export function consentFor(plan: ComputerPlan, at: Date, palId?: string): ConsentRecord {
	return {
		steps: plan.steps.map((step) => step.kind),
		at: at.toISOString(),
		...(palId ? { palId } : {}),
	}
}

export class ConsentStore {
	constructor(private readonly file: string) {}

	read(): ConsentRecord | undefined {
		try {
			const value = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
			if (
				value &&
				typeof value === 'object' &&
				Array.isArray((value as ConsentRecord).steps) &&
				(value as ConsentRecord).steps.every((step) => typeof step === 'string') &&
				typeof (value as ConsentRecord).at === 'string'
			) {
				const record = value as ConsentRecord
				return {
					steps: record.steps,
					at: record.at,
					...(typeof record.palId === 'string' ? { palId: record.palId } : {}),
				}
			}
		} catch {
			// No record, or one that cannot be read, agrees to nothing.
		}
		return undefined
	}

	write(record: ConsentRecord): void {
		mkdirSync(dirname(this.file), { recursive: true })
		writeFileSync(`${this.file}.tmp`, JSON.stringify(record), { mode: 0o600 })
		renameSync(`${this.file}.tmp`, this.file)
	}

	clear(): void {
		rmSync(this.file, { force: true })
	}
}
