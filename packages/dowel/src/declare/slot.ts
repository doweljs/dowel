import type { DeclaredScope, Named } from '../model/checks.ts'
import type { AnyScope, AnySlot, Optional, RootMeta, Slot } from '../model/declarations.ts'
import type { EmptySlotOptions, MaybeMany, MaybeMissingScope } from '../model/diagnostics.ts'
import type { MetaOf } from '../model/infer.ts'
import type { ScopeDescriptor } from '../model/scopes.ts'
import { scopeNode, slotNode } from '../nodes/coerce.ts'
import { allocateId, internal, ROOT, type SlotNode } from '../nodes/node.ts'

export type SlotAt<T, N extends string, Sc extends ScopeDescriptor, Many extends boolean> = Slot<
	T,
	{ readonly name: N; readonly scope: Sc['name']; readonly above: Sc['above']; readonly many: Many }
>

export interface SlotOptions {
	/**
	 * The scope the slot lives in. A scoped slot is supplied each time a
	 * container for its scope is opened, and every service depending on it
	 * lives in that scope. Root when omitted: bound once, at build().
	 */
	readonly scope?: AnyScope
	/**
	 * Collect every contribution made to the slot into a readonly array, in
	 * contribution order. A multi-binding never needs binding; with no
	 * contributions it resolves to `[]`.
	 */
	readonly many?: true
}

/**
 * `unknown` when the types can tell what the slot is from its options: each
 * one certainly given or certainly absent, with `scope` one
 * declared scope. Anything less (an optional property, a union with and
 * without it, an object typed `{}` that may hold either) would type the slot
 * as root and single-valued while it runs in a scope or collects an array.
 */
type ReadableOptions<N extends string, O extends SlotOptions> = [
	Has<O, 'scope'> | Has<O, 'many'>,
] extends [false]
	? EmptySlotOptions<N>
	: ([Has<O, 'scope'>] extends [false]
			? unknown
			: [O] extends [{ readonly scope: infer Sc extends AnyScope }]
				? DeclaredScope<Sc>
				: MaybeMissingScope<N>) &
			([Has<O, 'many'>] extends [false]
				? unknown
				: [O] extends [{ readonly many: true }]
					? unknown
					: MaybeMany<N>)

/** Whether each member of `O` has the key `K`: `true`, `false`, or `boolean` when only some do. */
type Has<O, K extends PropertyKey> = O extends unknown ? (K extends keyof O ? true : false) : never

type OptionScope<O extends SlotOptions> = O extends { readonly scope: infer Sc extends AnyScope }
	? MetaOf<Sc>
	: RootMeta

type OptionMany<O extends SlotOptions> = O extends { readonly many: true } ? true : false

/**
 * Declare a slot: a named capability whose implementation or value is
 * chosen when the container is built, or supplied when a container for its
 * scope is opened.
 *
 * ```ts
 * const Logger = slot('Logger')<{ info(message: string): void }>()
 * const Request = slot('Request', { scope: PerRequest })<IncomingRequest>()
 * const Middleware = slot('Middleware', { many: true })<Middleware>()
 * ```
 */
export function slot<N extends string>(name: N): <T>() => Named<N, SlotAt<T, N, RootMeta, false>>
export function slot<N extends string, const O extends SlotOptions>(
	name: N,
	// Required here, so options that may be undefined are not mistaken for none.
	options: O & ReadableOptions<N, O>,
): <T>() => Named<
	N,
	SlotAt<OptionMany<O> extends true ? readonly T[] : T, N, OptionScope<O>, OptionMany<O>>
>
export function slot(name: string, options?: SlotOptions): () => unknown {
	const scope = options?.scope === undefined ? ROOT : scopeNode(options.scope)
	const many = options?.many === true
	return () => {
		const node: SlotNode = { kind: 'slot', id: allocateId(), name, scope, many }
		return Object.freeze({ '~kind': 'slot', name, scope: scope.name, [internal]: node }) as AnySlot
	}
}

/**
 * Depend on a slot without requiring it to be bound. The factory receives
 * `undefined` when no binding exists.
 */
export function optional<G extends AnySlot>(target: G): Optional<G> {
	slotNode(target)
	return Object.freeze({ '~kind': 'optional', slot: target })
}
