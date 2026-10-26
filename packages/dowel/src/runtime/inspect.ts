import type { NodeInfo } from '../api.ts'
import { type BindingInfo, type Compiled, isCached, type Plan } from '../compile/plan.ts'
import { type Chain, UNSET } from './store/store.ts'

/** Every node of a compiled graph, with the state of the instances visible from `chain`. */
export function inspect(compiled: Compiled, chain: Chain): NodeInfo[] {
	const names = new Map<number, string>()
	for (const node of compiled.graph) names.set(node.id, node.name)
	const nameOf = (id: number): string => names.get(id) ?? '?'
	const binding = (info: BindingInfo | null): NodeInfo['binding'] => {
		if (info === null) return null
		switch (info.kind) {
			case 'service':
				return { kind: 'service', name: nameOf(info.id) }
			case 'many':
				return {
					kind: 'many',
					items: info.items.map((item) =>
						item.kind === 'service' ? { kind: 'service', name: nameOf(item.id) } : item,
					),
				}
			default:
				return info
		}
	}
	const status = (plan: Plan): NodeInfo['status'] => {
		if (!isCached(plan)) return null
		const store = chain[plan.scope.depth]
		// A sibling scope at the same depth has its own cells.
		if (store?.scope !== plan.scope) return null
		if (store.cells[plan.cell] !== UNSET) return 'ready'
		return store.pending?.[plan.cell] !== undefined ? 'pending' : 'idle'
	}
	return compiled.graph.map((node) => ({
		name: node.name,
		kind: node.kind,
		scope: node.scope.name,
		many: node.many,
		deps: node.deps.map((dep) => ({ key: dep.key, name: nameOf(dep.id) })),
		binding: binding(node.binding),
		status: status(node.plan),
	}))
}
