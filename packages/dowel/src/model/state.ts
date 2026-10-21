/**
 * The type-level state of a container builder: the merged graph and the
 * roots, how each builder operation changes them, and the checks `get()`,
 * `open()` and `override()` run against them.
 */

import type {
	AnyBinding,
	AnyExecution,
	AnyScope,
	AnyService,
	AnySlot,
	Binding,
	Execution,
	ScopeMeta,
	Service,
	Slot,
} from './declarations.ts'
import type {
	MissingScopeValues,
	NotChildScope,
	NotProvided,
	NotVisible,
	ScopeBindingsAtOtherScopes,
	ScopeBindingsBoundAtBuild,
	ScopeBindingsForMultiBindings,
	ScopeBindingsMustBeValues,
	UnknownLengthItems,
} from './diagnostics.ts'
import type {
	BoundInputs,
	EntryKind,
	EntryOf,
	Graph,
	MergeGraph,
	MissingAt,
	MissingInputs,
	NeededBy,
	Reach,
	RequiredBy,
} from './graph.ts'
import type { GraphOf, Infer, MetaOf } from './infer.ts'
import type { Simplify } from './util.ts'

export interface ContainerState {
	/** Every node known to the container, merged from what was provided, bound and overridden. */
	readonly graph: Graph
	/** Names activation starts from: provided services, executions and slots. */
	readonly roots: string
	/**
	 * Every binding made, as {@link BindingKey}s. Kept apart from the graph,
	 * where an override hides the binding it replaces, because the runtime
	 * still counts that binding.
	 */
	readonly bound: string
	/** Every override target, tagged by kind: `service:Name`, `slot:Name` or `many:Name`. */
	readonly overridden: string
	/** Problems found while composing, as sentences, reported by `build()`. */
	readonly issues: string
}

/**
 * A concrete state. Keeping it an interface keeps inferred builder types short.
 *
 * Composition problems are recorded here and reported by `build()` rather
 * than checked where they arise: a check on a parameter cannot be decided
 * while the state is generic, so it would reject every call in a reusable
 * composition function.
 */
export interface State<
	G extends Graph,
	R extends string,
	B extends string = never,
	O extends string = never,
	I extends string = never,
> extends ContainerState {
	readonly graph: G
	readonly roots: R
	readonly bound: B
	readonly overridden: O
	readonly issues: I
}

export type EmptyState = State<{}, never>

export type Providable = AnyService | AnyExecution | AnySlot | AnyBinding

/**
 * The state after providing one item. Services, executions and slots become
 * roots; bindings only make implementations available.
 *
 * Deferred while `S` is generic: a composition function's inferred type then
 * names each step (`Provide<Provide<S, A>, B>`) instead of spelling out the
 * merged graph, which grows with every step until declaration files cannot
 * hold it.
 */
export type Provide<S extends ContainerState, I> = S extends ContainerState
	? I extends Binding<any, infer M>
		? State<
				MergeGraph<S['graph'], M['graph']>,
				S['roots'],
				S['bound'] | BindingKey<M>,
				S['overridden'],
				S['issues'] | BoundTwice<Extract<BindingKey<M>, S['bound']>>
			>
		: I extends Service<any, infer M>
			? Root<S, M['graph'], M['name']>
			: I extends Execution<any, infer M>
				? Root<S, M['graph'], M['name']>
				: I extends Slot<any, infer M>
					? Root<S, GraphOf<I>, M['name']>
					: S
	: never

type Root<S extends ContainerState, G extends Graph, Name extends string> = State<
	MergeGraph<S['graph'], G>,
	S['roots'] | Name,
	S['bound'],
	S['overridden'],
	S['issues']
>

/**
 * What a binding decides: its slot, or for a service contributed to a
 * multi-binding `Slot<-Service`. Values contributed to a multi-binding
 * decide nothing, since any number of them may be added.
 */
type BindingKey<M extends { readonly name: string; readonly graph: Graph }> =
	M['graph'][M['name']] extends {
		readonly kind: infer Kind
		readonly deps: infer Deps extends string
	}
		? Kind extends 'many'
			? `${M['name']}<-${Deps}`
			: M['name']
		: never

type BoundTwice<Key extends string> = Key extends `${infer Slot}<-${infer Item}`
	? `'${Item}' is contributed to '${Slot}' twice`
	: Key extends string
		? `'${Key}' is bound twice; use override() to replace a binding`
		: never

/** The state after providing a tuple of items, left to right. */
export type ProvideAll<
	S extends ContainerState,
	Items extends readonly unknown[],
> = Items extends readonly [infer Head, ...infer Rest] ? ProvideAll<Provide<S, Head>, Rest> : S

/**
 * `unknown` when `Items` is a tuple. An array of unknown length may hold any
 * subset of its element types, so none of them could count as provided.
 */
export type KnownLength<Items extends readonly unknown[]> = number extends Items['length']
	? UnknownLengthItems
	: unknown

type AliasEntry<Existing, To extends string> = {
	readonly kind: 'alias'
	readonly scope: Existing extends { scope: infer Sc } ? Sc : string
	readonly above: Existing extends { above: infer A } ? A : string
	readonly deps: To
	readonly optional: never
	readonly child: never
	readonly inputs: never
}

type ValueEntry<Existing> = {
	readonly kind: 'replaced'
	readonly scope: Existing extends { scope: infer Sc } ? Sc : string
	readonly above: Existing extends { above: infer A } ? A : string
	readonly deps: never
	readonly optional: never
	readonly child: never
	readonly inputs: never
}

/**
 * The state after overriding the node `Target` names with `I`, where
 * `Target` is tagged by kind as in {@link ContainerState.overridden}.
 * Deferred while `S` is generic, like {@link Provide}.
 */
export type Override<
	S extends ContainerState,
	Target extends `${'service' | 'slot' | 'many'}:${string}`,
	I,
> = S extends ContainerState
	? Target extends `${string}:${infer Name}`
		? State<
				MergeGraph<
					S['graph'],
					I extends Service<any, infer M>
						? MergeGraph<
								M['graph'],
								{ readonly [K in Name]: AliasEntry<EntryOf<S['graph'], Name>, M['name']> }
							>
						: { readonly [K in Name]: ValueEntry<EntryOf<S['graph'], Name>> }
				>,
				S['roots'],
				S['bound'],
				S['overridden'] | Target,
				S['issues']
			>
		: never
	: never

/** An override target tagged by kind, from its metadata. */
export type TargetOf<M extends { readonly name: string }> = M extends { readonly many: true }
	? `many:${M['name']}`
	: M extends { readonly many: false }
		? `slot:${M['name']}`
		: `service:${M['name']}`

type OverrideIssue<S extends ContainerState, Target> = Target extends `service:${infer Name}`
	? Name extends Reachable<S>
		? never
		: `'${Name}' is overridden but nothing provided reaches it`
	: Target extends `slot:${infer Name}`
		? Name extends S['bound']
			? never
			: `'${Name}' is overridden but never bound; bind it instead`
		: never

/** Names whose dependencies a binding or override decided: a cycle can only pass through one. */
type Decided<G extends Graph> = {
	[K in keyof G]: G[K]['kind'] extends 'bound' | 'alias' | 'many' ? K : never
}[keyof G]

type CycleIssue<G extends Graph, Name> = Name extends keyof G & string
	? Name extends Reach<G, G[Name]['deps']>
		? `'${Name}' depends on itself through '${G[Name]['deps']}'`
		: never
	: never

/** Every problem `build()` reports before it is callable. */
export type Issues<S extends ContainerState> =
	| S['issues']
	| OverrideIssue<S, S['overridden']>
	| CycleIssue<S['graph'], Extract<Decided<S['graph']>, Reachable<S>>>

type Reachable<S extends ContainerState> = Reach<S['graph'], S['roots']>

/** Root-scope slots that must be bound before `build()`. */
export type Missing<S extends ContainerState> = MissingAt<S['graph'], S['roots'], 'root'>

/** Executions whose declared inputs do not cover what their entry needs. */
export type MissingExecutionInputs<S extends ContainerState> = MissingInputs<S['graph'], S['roots']>

/** Executions with inputs that are also bound at build(). */
export type BoundExecutionInputs<S extends ContainerState> = BoundInputs<S['graph'], S['roots']>

type Check<Name extends string, N, S extends ContainerState, Current extends ScopeMeta> =
	Name extends Reachable<S>
		? EntryOf<S['graph'], Name>['scope'] extends Current['name'] | Current['above']
			? N
			: NotVisible<Name, EntryOf<S['graph'], Name>['scope']>
		: NotProvided<Name>

export type Resolvable<N, S extends ContainerState, Current extends ScopeMeta> =
	N extends Service<any, infer M>
		? Check<M['name'], N, S, Current>
		: N extends Execution<any, infer M>
			? Check<M['name'], N, S, Current>
			: N extends Slot<any, infer M>
				? Check<M['name'], N, S, Current>
				: never

/**
 * What `get()` returns: an unbound slot that is only used optionally may be
 * `undefined`, unless `Supplied` (the slots passed to `open()` for this
 * container and those it was opened from) includes it.
 */
export type GetResult<N, S extends ContainerState, Supplied extends string = never> =
	N extends Slot<infer T, infer M>
		? EntryOf<S['graph'], M['name']>['kind'] extends 'slot'
			? M['name'] extends S['roots'] | RequiredBy<S['graph'], Reachable<S>> | Supplied
				? T
				: T | undefined
			: T
		: Infer<N>

/** A slot or service, matched structurally so one signature covers both. */
export type Overridable<T, M> = {
	readonly '~kind': 'service' | 'slot'
	readonly '~type'?: T
	readonly '~meta'?: M
}

/** The names of the slots a list of bindings supplies. */
export type BoundNames<B extends readonly AnyBinding[]> = MetaOf<B[number]>['name']

/** Names of the bindings in `B` whose own entry has the given kind and scope. */
type BindingsWhere<B extends readonly AnyBinding[], Kind, Scope> = B[number] extends infer Item
	? Item extends Binding<any, infer M>
		? M['graph'][M['name']] extends { readonly kind: Kind; readonly scope: Scope }
			? M['name']
			: never
		: never
	: never

type ManyBindings<B extends readonly AnyBinding[]> = BindingsWhere<B, 'many', string>
type NonValueBindings<B extends readonly AnyBinding[]> = BindingsWhere<B, 'bound', string>

/** Bindings for slots that do not live at `Sc`. */
type OtherScopeBindings<B extends readonly AnyBinding[], Sc extends string> = Exclude<
	BoundNames<B>,
	BindingsWhere<B, EntryKind, Sc>
>

type BuildBound<S extends ContainerState, Name> = Name extends keyof S['graph']
	? S['graph'][Name]['kind'] extends 'slot'
		? never
		: Name
	: never

/** Bindings for slots whose value build() already decides. */
type BuildBoundBindings<S extends ContainerState, B extends readonly AnyBinding[]> = BuildBound<
	S,
	BoundNames<B>
>

/** Required scoped slots at `Sc` that the bindings `B` do not supply. */
type ScopeMissing<
	S extends ContainerState,
	Sc extends string,
	B extends readonly AnyBinding[],
> = Exclude<MissingAt<S['graph'], S['roots'], Sc>, BoundNames<B>>

/**
 * `unknown` when the bindings complete a container for scope `Sc`; otherwise an
 * object type the bindings cannot satisfy, whose property names the problem.
 */
export type OpenCheck<
	S extends ContainerState,
	Sc extends string,
	B extends readonly AnyBinding[],
> = [ManyBindings<B>] extends [never]
	? [NonValueBindings<B>] extends [never]
		? [OtherScopeBindings<B, Sc>] extends [never]
			? [BuildBoundBindings<S, B>] extends [never]
				? [ScopeMissing<S, Sc, B>] extends [never]
					? unknown
					: MissingScopeValues<Simplify<NeededBy<S['graph'], ScopeMissing<S, Sc, B>>>>
				: ScopeBindingsBoundAtBuild<BuildBoundBindings<S, B>>
			: ScopeBindingsAtOtherScopes<OtherScopeBindings<B, Sc>>
		: ScopeBindingsMustBeValues<NonValueBindings<B>>
	: ScopeBindingsForMultiBindings<ManyBindings<B>>

/** `unknown` when `Sc` is a direct child of the container's scope `Current`. */
export type ChildCheck<
	Current extends ScopeMeta,
	Sc extends AnyScope,
> = MetaOf<Sc>['parent'] extends Current['name']
	? unknown
	: NotChildScope<MetaOf<Sc>['name'], Current['name']>
