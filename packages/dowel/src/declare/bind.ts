import { implOf, slotNode } from '../nodes/coerce.ts'
import { assertImplScope } from '../nodes/hierarchy.ts'
import { type BindingNode, internal } from '../nodes/node.ts'

/** The binding `Slot.of()` returns: a slot paired with a value or a service, or one contribution. */
export function bindingOf(slot: unknown, impl: unknown): unknown {
	const target = slotNode(slot)
	const node: BindingNode = { kind: 'binding', slot: target, impl: implOf(impl) }
	assertImplScope(target, node.impl, target.many ? 'contribution' : 'implementation')
	return Object.freeze({ '~kind': 'binding', slot, [internal]: node })
}
