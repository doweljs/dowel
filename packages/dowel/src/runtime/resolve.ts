/** Resolving a plan against a chain of stores. */

import type { Plan } from '../compile/plan.ts'
import { DowelError } from '../errors.ts'
import { runner } from './executions/run.ts'
import { init, isPromiseLike } from './instances/create.ts'
import { type Chain, storeAt, UNSET } from './store/store.ts'

/** Resolves a plan's value synchronously, throwing if an async instance is not ready. */
export function resolve(plan: Plan, chain: Chain): unknown {
	switch (plan.kind) {
		case 'value':
			return plan.value
		case 'scopeValue': {
			const value = storeAt(plan, chain).cells[plan.cell]
			return value === UNSET ? undefined : value
		}
		case 'execution':
			return runner(plan, chain)
		case 'service':
		case 'many': {
			const result = init(plan, chain)
			if (!isPromiseLike(result)) return result
			throw new DowelError(
				'NOT_READY',
				`Service '${plan.name}' is not ready: its initialization is still in flight or failed. Resolve it only after build() or open() resolved.`,
			)
		}
	}
}
