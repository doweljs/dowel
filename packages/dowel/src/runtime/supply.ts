import type { ScopePlan } from '../compile/plan.ts'
import { DowelError } from '../errors.ts'
import { assertDistinctNames } from '../nodes/hierarchy.ts'
import { type BindingNode, ROOT } from '../nodes/node.ts'
import type { Store } from './store.ts'

/** Writes the values a container was opened with into its store and checks nothing required is missing. */
export function supply(
	scopePlan: ScopePlan,
	store: Store,
	bindings: readonly BindingNode[],
	required: ReadonlySet<string>,
): void {
	const supplied = new Set<string>()
	for (const { slot, impl } of bindings) {
		if (impl.kind !== 'value') {
			throw new DowelError(
				'INVALID_NODE',
				`Slot '${slot.name}' was bound to a service when opening a container. The bindings open() takes carry values; bind the service at build() instead.`,
			)
		}
		if (slot.scope !== scopePlan.scope) {
			assertDistinctNames(slot.scope, scopePlan.scope, `Opening scope '${scopePlan.scope.name}'`)
			throw new DowelError(
				'INVALID_SCOPE',
				`Slot '${slot.name}' lives in scope '${slot.scope.name}', so opening '${scopePlan.scope.name}' cannot supply it.${slot.scope === ROOT ? ' Bind it at build() instead.' : ''}`,
			)
		}
		if (slot.many) {
			throw new DowelError(
				'INVALID_NODE',
				`Slot '${slot.name}' is a multi-binding, which open() cannot supply. Contribute to it at build() instead.`,
			)
		}
		// Otherwise the graph resolves it another way and would silently ignore the value.
		if (scopePlan.bound.has(slot.name)) {
			throw new DowelError(
				'DUPLICATE',
				`Slot '${slot.name}' is bound at build(), so opening '${scopePlan.scope.name}' cannot supply it.`,
			)
		}
		const plan = scopePlan.values.get(slot.name)
		// Nothing reached depends on it.
		if (plan === undefined) continue
		store.cells[plan.cell] = impl.value
		supplied.add(slot.name)
	}
	for (const name of required) {
		if (!supplied.has(name)) {
			throw new DowelError(
				'MISSING_SCOPE_VALUE',
				`Slot '${name}' needs a value when '${scopePlan.scope.name}' is opened. Pass bind(${name}, value).`,
			)
		}
	}
}
