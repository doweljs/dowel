import type { DeclaredScope, LiteralName } from '../model/checks.ts'
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
	/** The scope the slot lives in and is supplied for at `open()`; root, bound at `build()`, when omitted. */
	readonly scope?: AnyScope
	/** Collect every contribution into a readonly array, `[]` when there is none. */
	readonly many?: true
}

/**
 * `unknown` when each option is certainly given or certainly absent, with
 * `scope` one declared scope. Anything less would type the slot as root and
 * single-valued while it runs in a scope or collects an array.
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
 * Declare a slot: a named gap filled at `build()`, or at `open()` for its scope.
 *
 * ```ts
 * const Logger = slot('Logger')<{ info(message: string): void }>()
 * const Request = slot('Request', { scope: PerRequest })<IncomingRequest>()
 * const Middleware = slot('Middleware', { many: true })<Middleware>()
 * ```
 */
export function slot<N extends string>(name: LiteralName<N>): <T>() => SlotAt<T, N, RootMeta, false>
export function slot<N extends string, const O extends SlotOptions>(
	name: LiteralName<N>,
	// Required here, so options that may be undefined are not mistaken for none.
	options: O & ReadableOptions<N, O>,
): <T>() => SlotAt<OptionMany<O> extends true ? readonly T[] : T, N, OptionScope<O>, OptionMany<O>>
export function slot(name: string, options?: SlotOptions): () => unknown {
	const scope = options?.scope === undefined ? ROOT : scopeNode(options.scope)
	const many = options?.many === true
	// One slot per declaration: the call that gives it its type returns the same slot every time.
	const node: SlotNode = { kind: 'slot', id: allocateId(), name, scope, many }
	const declared = Object.freeze({ '~kind': 'slot', name, scope: scope.name, [internal]: node })
	return () => declared as AnySlot
}

/** Depend on a slot without requiring it bound; the factory receives `undefined` when it is not. */
export function optional<G extends AnySlot>(target: G): Optional<G> {
	slotNode(target)
	return Object.freeze({ '~kind': 'optional', slot: target })
}
