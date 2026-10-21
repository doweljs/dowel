/**
 * Holds the type-level model to a compile-time budget. Checks a fixed
 * workload, the generated scale test, under TypeScript 5.9, the supported
 * floor, and fails when it needs more type instantiations than
 * `type-budget.json` allows, so a new check has to pay for itself. Other
 * tests are left out: they grow with every feature, which would charge the
 * model for its own test coverage.
 *
 * `bun scripts/type-budget.ts --update` records the current count as the
 * new baseline, for a change whose cost is deliberate.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface Budget {
	/** Instantiations the last accepted change needed. */
	readonly instantiations: number
	/** How far above the baseline a change may go, as a fraction. */
	readonly tolerance: number
}

const root = join(import.meta.dir, '..')
const budgetPath = join(import.meta.dir, 'type-budget.json')

const result = Bun.spawnSync(
	[
		'node',
		join(root, 'node_modules/typescript59/bin/tsc'),
		'-p',
		join(root, 'packages/dowel/tsconfig.budget.json'),
		'--noEmit',
		'--extendedDiagnostics',
	],
	{ cwd: root },
)
const output = result.stdout.toString()
const match = /^Instantiations:\s+(\d+)$/m.exec(output)
if (result.exitCode !== 0 || match === null) {
	console.error(output, result.stderr.toString())
	throw new Error('The type check failed, so its cost could not be measured.')
}
const instantiations = Number(match[1])

if (process.argv.includes('--update')) {
	const previous = JSON.parse(readFileSync(budgetPath, 'utf8')) as Budget
	const budget: Budget = { ...previous, instantiations }
	writeFileSync(budgetPath, `${JSON.stringify(budget, null, '\t')}\n`)
	console.log(`Recorded ${instantiations} instantiations as the baseline.`)
} else {
	const budget = JSON.parse(readFileSync(budgetPath, 'utf8')) as Budget
	const limit = Math.round(budget.instantiations * (1 + budget.tolerance))
	const change = ((instantiations / budget.instantiations - 1) * 100).toFixed(1)
	console.log(`${instantiations} instantiations (${change}% against the baseline, limit ${limit}).`)
	if (instantiations > limit) {
		console.error(
			'Over budget. Make the new types cheaper, or record a deliberate cost with --update.',
		)
		process.exit(1)
	}
}
