/**
 * The phantom types of what users declare. They exist so the compiler can
 * prove a container complete before it is built; the runtime never reads the
 * `~`-prefixed properties.
 */

import type { Graph } from './graph.ts'

export interface ScopeMeta {
	readonly name: string
	/** The direct parent's name; `never` for `root`. */
	readonly parent: string
	/** Every ancestor scope's name, `root` included; `never` for `root`. */
	readonly above: string
}

export interface Scope<M extends ScopeMeta = ScopeMeta> {
	readonly '~kind': 'scope'
	readonly name: M['name']
	readonly '~meta'?: M
}

export type AnyScope = Scope<ScopeMeta>

export type RootMeta = { readonly name: 'root'; readonly parent: never; readonly above: never }

/** A scope as seen from a node that lives in it: the name and what is above. */
export interface Placement {
	readonly scope: string
	readonly above: string
}

export interface SlotMeta extends Placement {
	readonly name: string
	readonly many: boolean
}

export interface Slot<T, M extends SlotMeta = SlotMeta> {
	readonly '~kind': 'slot'
	readonly name: M['name']
	readonly scope: M['scope']
	readonly '~type'?: T
	readonly '~meta'?: M
}

export type AnySlot = Slot<any, SlotMeta>

/** A dependency on a slot that may be left unbound. Resolves to `T | undefined`. */
export interface Optional<G extends AnySlot> {
	readonly '~kind': 'optional'
	readonly slot: G
}

/** The element type of a multi-binding slot. */
export type ItemOf<T> = T extends readonly (infer I)[] ? I : never

export interface ServiceMeta extends Placement {
	readonly name: string
	/** The service's subgraph, itself included, keyed by node name. */
	readonly graph: Graph
}

export interface Service<T, M extends ServiceMeta = ServiceMeta> {
	readonly '~kind': 'service'
	readonly name: M['name']
	readonly scope: M['scope']
	readonly '~type'?: T
	readonly '~meta'?: M
}

export type AnyService = Service<any, ServiceMeta>

export interface ExecutionMeta extends Placement {
	readonly name: string
	/** The scope each run of the execution opens a container for. */
	readonly child: string
	/** Names of the slots supplied when it runs. */
	readonly inputs: string
	/** The execution's subgraph: its entry, its inputs and itself. */
	readonly graph: Graph
}

/** `T` is the runner type a dependent receives. */
export interface Execution<T, M extends ExecutionMeta = ExecutionMeta> {
	readonly '~kind': 'execution'
	readonly name: M['name']
	readonly scope: M['scope']
	readonly '~type'?: T
	readonly '~meta'?: M
}

export type AnyExecution = Execution<any, ExecutionMeta>

/** What a factory may depend on. */
export type Dep = AnySlot | AnyService | AnyExecution | Optional<AnySlot>
export type Deps = { readonly [key: string]: Dep }

/** The declared dependencies of a service, as a union. */
export type DepValues<D extends Deps> = D[keyof D]

export interface BindingMeta {
	/** The bound slot's name. */
	readonly name: string
	/** The entry for the slot, merged with the implementation's subgraph. */
	readonly graph: Graph
}

/** A slot paired with its implementation, or a contribution to a multi-binding. Created by {@link bind}. */
export interface Binding<T, M extends BindingMeta = BindingMeta> {
	readonly '~kind': 'binding'
	readonly slot: Slot<any, SlotMeta>
	readonly '~type'?: T
	readonly '~meta'?: M
}

export type AnyBinding = Binding<any, BindingMeta>
