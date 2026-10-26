import type { DeclaredName } from '../model/checks.ts'
import type { Binding, Slot, SlotMeta } from '../model/declarations.ts'
import type { BindingMetaOf, Impl } from '../model/infer.ts'
import { implOf, slotNode } from '../nodes/coerce.ts'
import { assertImplScope } from '../nodes/hierarchy.ts'
import { type BindingNode, internal } from '../nodes/node.ts'

/**
 * Bind a slot to a value or a service, or contribute one item to a
 * multi-binding. Bound values are borrowed: the container never disposes them.
 *
 * ```ts
 * container().provide(bind(Logger, PinoLogger), bind(Config, { port: 3000 }))
 * await using request = await app.open(PerRequest, bind(Request, req))
 * ```
 */
export function bind<T, TM extends SlotMeta, const I extends Impl<T, TM>>(
	slot: Slot<T, TM> & DeclaredName<Slot<T, TM>>,
	impl: I,
): Binding<T, BindingMetaOf<TM, I>> {
	const target = slotNode(slot)
	const node: BindingNode = { kind: 'binding', slot: target, impl: implOf(impl) }
	assertImplScope(target, node.impl, target.many ? 'contribution' : 'implementation')
	return Object.freeze({ '~kind': 'binding', slot, [internal]: node }) as Binding<
		T,
		BindingMetaOf<TM, I>
	>
}
