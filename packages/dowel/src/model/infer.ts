/**
 * From declarations to graph entries: the metadata a service or binding
 * carries, and the types its factory and dependents see.
 */

import type {
	Deps,
	DepValues,
	Execution,
	ItemOf,
	Optional,
	Placement,
	Service,
	ServiceMeta,
	Slot,
	SlotMeta,
} from './declarations.ts'
import type { MergeGraph } from './graph.ts'
import type { ScopeDescriptor } from './scopes.ts'
import type { Simplify, UnionToIntersection } from './util.ts'

/** The instance type of a slot or service, or the runner type of an execution. */
export type Infer<N> = N extends { readonly '~type'?: infer T } ? T : never

export type MetaOf<N> = N extends { readonly '~meta'?: infer M } ? M : never

type ResolvedDep<D> =
	D extends Optional<infer G>
		? Infer<G> | undefined
		: D extends { readonly '~type'?: infer T }
			? T
			: never

/** The object a factory receives, shaped like its `deps` declaration. */
export type Resolved<D extends Deps> = { readonly [K in keyof D]: ResolvedDep<D[K]> }

type SlotEntry<M extends SlotMeta> = {
	readonly kind: M['many'] extends true ? 'many' : 'slot'
	readonly scope: M['scope']
	readonly above: M['above']
	readonly deps: never
	readonly optional: never
	readonly child: never
	readonly inputs: never
}

/** The subgraph a dependency contributes. */
export type GraphOf<N> =
	N extends Service<any, infer M>
		? M['graph']
		: N extends Execution<any, infer M>
			? M['graph']
			: N extends Slot<any, infer M>
				? { readonly [K in M['name']]: SlotEntry<M> }
				: N extends Optional<infer G>
					? GraphOf<G>
					: {}

export type NameOf<N> = N extends { readonly name: infer Name extends string } ? Name : never

type DepName<D> = D extends Optional<infer G> ? NameOf<G> : NameOf<D>
type RequiredName<D> = D extends Optional<any> ? never : NameOf<D>
/** Names used only optionally: a required edge on the same slot keeps it required. */
type OptionalOnlyName<D> = Exclude<D extends Optional<infer G> ? NameOf<G> : never, RequiredName<D>>

// Extract each graph before forming a union, so the checker does not have to
// compare whole dependency types (including their instances and transitive graphs).
// Intersecting with {} also gives empty dependencies an empty graph, without
// first forming a union of their values just to check for never.
// Remove optional modifiers so indexing cannot add undefined to the intersection.
export type DependencyGraph<D extends Deps> = UnionToIntersection<
	{ [K in keyof D]-?: GraphOf<D[K]> }[keyof D]
> & {}

/** Computes the metadata of a service from its declaration. */
export type ComputeMeta<N extends string, D extends Deps, Sc extends ScopeDescriptor> = {
	readonly name: N
	readonly scope: Sc['name']
	readonly above: Sc['above']
	// Preserve shared subgraphs as intersections. Remapping every transitive
	// entry here makes checking dependent service declarations much more expensive.
	readonly graph: DependencyGraph<D> & {
		readonly [K in N]: {
			readonly kind: 'service'
			readonly scope: Sc['name']
			readonly above: Sc['above']
			readonly deps: DepName<DepValues<D>>
			readonly optional: OptionalOnlyName<DepValues<D>>
			readonly child: never
			readonly inputs: never
		}
	}
}

/** Services that may stand in for a node (implement a slot, contribute, override): in its scope or above. */
export type ImplAt<T, Sc extends Placement> = Service<
	T,
	ServiceMeta & { readonly scope: Sc['scope'] | Sc['above'] }
>

/** What `bind()` accepts for a slot: the value, a service producing it, or for multi-bindings one item. */
export type Impl<T, TM extends SlotMeta> = TM['many'] extends true
	? NoInfer<ItemOf<T>> | ImplAt<ItemOf<T>, TM>
	: NoInfer<T> | ImplAt<T, TM>

type BindingEntry<
	TM extends SlotMeta,
	Kind extends 'bound' | 'value' | 'many',
	Names extends string,
> = {
	readonly kind: Kind
	readonly scope: TM['scope']
	readonly above: TM['above']
	readonly deps: Names
	readonly optional: never
	readonly child: never
	readonly inputs: never
}

export type BindingMetaOf<TM extends SlotMeta, I> = {
	readonly name: TM['name']
	readonly graph: I extends Service<any, infer M>
		? MergeGraph<
				M['graph'],
				{
					readonly [K in TM['name']]: BindingEntry<
						TM,
						TM['many'] extends true ? 'many' : 'bound',
						M['name']
					>
				}
			>
		: Simplify<{
				readonly [K in TM['name']]: BindingEntry<
					TM,
					TM['many'] extends true ? 'many' : 'value',
					never
				>
			}>
}
