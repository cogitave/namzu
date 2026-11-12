/**
 * `namzu cost` — what the conversations on this machine cost, by local day and
 * by model, from what the kernel already recorded.
 *
 * The same view the terminal shows with `/cost days`, as text or as JSON
 * (`--json`; the shape is documented in `docs/cli/cost.md` and carries a
 * `schemaVersion`). Nothing is collected for it and nothing leaves the
 * machine: it reads the session logs through a small rebuildable summary
 * beside the index.
 */

import { EXIT_FAIL, EXIT_OK, EXIT_USAGE } from '../exit-codes.js'
import {
	DEFAULT_SPEND_DAYS,
	MAX_SPEND_DAYS,
	type SpendClock,
	systemClock,
} from '../integrations/spend/day.js'
import { refreshLedger } from '../integrations/spend/ledger.js'
import { renderSpend } from '../integrations/spend/render.js'
import { type SpendReport, buildSpendReport } from '../integrations/spend/report.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import { createFormatter } from '../output/index.js'
import type { CommandDef } from './types.js'

const HELP = `namzu cost — spend across conversations on this machine, by day and model

Usage:
  namzu cost [--days <n>] [--json]

Shows the last ${DEFAULT_SPEND_DAYS} local days by default: totals by day, model and project,
and by kind of work (your replies, sub-agents, compaction, other internal calls),
with cache reads and writes apart from fresh input.

Money is an estimate from list prices. A model with no known price shows its
tokens and "price not known", and the total then says it is partial.

  --days <n>   Days to cover, today included (1 to ${MAX_SPEND_DAYS}).
  --json       Print the report as JSON (schemaVersion 1) instead of text.

For the latest reply only, use /cost in the terminal.\n`

export interface CostArgs {
	readonly days: number
	readonly json: boolean
}

/** `undefined` for arguments the command does not take. */
export function parseCostArgs(args: readonly string[]): CostArgs | undefined {
	let days = DEFAULT_SPEND_DAYS
	let json = false
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] as string
		if (arg === '--json') {
			json = true
		} else if (arg === '--days' || arg.startsWith('--days=')) {
			let value: string | undefined
			if (arg === '--days') {
				i += 1
				value = args[i]
			} else {
				value = arg.slice('--days='.length)
			}
			if (value === undefined || !/^[1-9]\d{0,3}$/.test(value)) return undefined
			days = Number(value)
			if (days > MAX_SPEND_DAYS) return undefined
		} else {
			return undefined
		}
	}
	return { days, json }
}

export interface CostDeps {
	readonly home: string
	readonly clock: SpendClock
}

export async function buildCostReport(days: number, deps: CostDeps): Promise<SpendReport> {
	const { ledger } = await refreshLedger({ home: deps.home })
	return buildSpendReport({ ledger, clock: deps.clock, days })
}

export const costCommand: CommandDef = {
	name: 'cost',
	description: 'Show spend across conversations by day and model, from the session logs',
	passThrough: true,
	help: HELP,
	handler: async ({ ctx, rawArgs }) => {
		const parsed = parseCostArgs(rawArgs)
		if (parsed === undefined) {
			ctx.formatter.error({ message: HELP })
			return EXIT_USAGE
		}
		try {
			const report = await buildCostReport(parsed.days, {
				home: resolveNamzuHome(),
				clock: systemClock(),
			})
			if (parsed.json) {
				createFormatter('json', { quiet: false }).print(report)
			} else if (ctx.formatter.name === 'text') {
				ctx.formatter.print({ text: renderSpend(report) })
			} else {
				ctx.formatter.print(report)
			}
			return EXIT_OK
		} catch (cause) {
			ctx.formatter.error({
				message: `Could not read the spend: ${cause instanceof Error ? cause.message : String(cause)}`,
			})
			return EXIT_FAIL
		}
	},
}
