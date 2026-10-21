/**
 * The graph record and its algebra.
 *
 * A container's graph is a record keyed by node name. Declarations, bindings
 * and overrides each contribute entries, merged by {@link MergeGraph}; every
 * question a container answers (what is missing, what is reachable, which
 * execution lacks inputs) is a walk over that record.
 */

/**
 * - `service`: a service with a factory.
 * - `slot`: an unbound slot. Required unless every usage is optional.
 * - `many`: a multi-binding slot; `deps` are its contributions.
 * - `bound`: a slot bound to a service named in `deps`.
 * - `value`: a slot bound to a value.
 * - `replaced`: a node overridden with a value.
 * - `alias`: a node overridden by the service named in `deps`.
 * - `execution`: work in a child scope; `deps` is its entry, `child` its scope, `inputs` its declared inputs.
 */
export type EntryKind =
	| 'service'
	| 'slot'
	| 'many'
	| 'bound'
	| 'value'
	| 'replaced'
	| 'alias'
	| 'execution'

export interface GraphEntry {
	readonly kind: EntryKind
	readonly scope: string
	readonly above: string
	/** Names this node depends on: dependencies, the implementation, contributions, the alias target, or the execution entry. */
	readonly deps: string
	/** The subset of `deps` used only optionally. */
	readonly optional: string
	/** Executions: the scope each run opens a container for. */
	readonly child: string
	/** Executions: slots supplied when they run. */
	readonly inputs: string
}

export type Graph = { readonly [name: string]: GraphEntry }

type WithDeps<E extends GraphEntry, Names extends string> = {
	readonly [K in keyof E]: K extends 'deps' ? Names : E[K]
}

/** Entries that come from declarations, as opposed to composition decisions. */
type DeclarationKind = 'service' | 'slot' | 'execution'

/** Entries an override produces. */
type OverrideKind = 'replaced' | 'alias'

/**
 * Combines two entries for the same name. Composition decisions (bindings,
 * values, aliases) always win over the entry a declaration contributes,
 * whichever arrives later; contributions to a multi-binding accumulate. As
 * at runtime, an override wins over any binding or contribution, whichever
 * arrives later, and a later override replaces an earlier one.
 */
type MergeEntry<X extends GraphEntry, Y extends GraphEntry> = X['kind'] extends OverrideKind
	? Y['kind'] extends OverrideKind
		? Y
		: X
	: Y['kind'] extends 'many'
		? X['kind'] extends 'many'
			? WithDeps<Y, X['deps'] | Y['deps']>
			: Y
		: Y['kind'] extends DeclarationKind
			? X
			: Y

// Exported through inferred.ts so consumer declarations can name the merge
// directly, without another mapped type to flatten it.
export type MergeGraph<A extends Graph, B extends Graph> = {
	readonly [K in keyof A | keyof B]: K extends keyof B
		? K extends keyof A
			? MergeEntry<A[K], B[K]>
			: B[K]
		: K extends keyof A
			? A[K]
			: never
}

export type EntryOf<G extends Graph, Name> = Name extends keyof G ? G[Name] : never

/**
 * Every name reachable from `S` through dependencies, bindings, contributions,
 * aliases and executions. `S` is the frontier: only newly reached names have
 * their edges expanded, and `Seen` also makes cycles terminate.
 */
export type Reach<G extends Graph, S extends string, Seen extends string = never> = [S] extends [
	never,
]
	? Seen
	: Reach<G, Exclude<EntryOf<G, S>['deps'], Seen | S>, Seen | S>

/**
 * The names a container creates with itself: those reachable from `S`
 * without entering an execution's entry, since runs create what that reaches
 * on demand.
 */
export type ReachEager<G extends Graph, S extends string, Seen extends string = never> = [
	S,
] extends [never]
	? Seen
	: ReachEager<
			G,
			Exclude<Exclude<EntryOf<G, S>, { readonly kind: 'execution' }>['deps'], Seen | S>,
			Seen | S
		>

/** Names that reachable services and executions depend on non-optionally. */
// Narrow R here rather than making recursive traversal results prove a string constraint.
export type RequiredBy<G extends Graph, R> = R extends keyof G
	? G[R]['kind'] extends 'service' | 'execution'
		? Exclude<G[R]['deps'], G[R]['optional']>
		: never
	: never

type UnboundAt<G extends Graph, Names extends string, Sc extends string> = Names extends keyof G
	? G[Names]['kind'] extends 'slot'
		? G[Names]['scope'] extends Sc
			? Names
			: never
		: never
	: never

/** Unbound, required slots in a scope, reachable from the roots. A slot provided as a root is required too. */
export type MissingAt<G extends Graph, Roots extends string, Sc extends string> = UnboundAt<
	G,
	Roots | RequiredBy<G, Reach<G, Roots>>,
	Sc
>

type ExecutionsIn<G extends Graph, R> = R extends keyof G & string
	? G[R]['kind'] extends 'execution'
		? R
		: never
	: never

/** Executions among `S` whose runs open containers for `Sc`. */
type OpeningAt<G extends Graph, S extends string, Sc extends string> = S extends keyof G
	? G[S]['kind'] extends 'execution'
		? G[S]['child'] extends Sc
			? S
			: never
		: never
	: never

/**
 * What a run at `Sc` reaches from `S` in its own scope. An execution
 * opening its own container for `Sc` is excluded before visiting its edges.
 */
type ReachWithin<
	G extends Graph,
	S extends string,
	Sc extends string,
	Seen extends string = never,
	Current extends string = Exclude<S, OpeningAt<G, S, Sc>>,
> = [Current] extends [never]
	? Seen
	: ReachWithin<G, Exclude<EntryOf<G, Current>['deps'], Seen | Current>, Sc, Seen | Current>

/** Scoped slots an execution's entry needs in the child scope that its inputs do not supply. */
export type MissingInputsOf<G extends Graph, Name extends string> = Exclude<
	UnboundAt<
		G,
		| EntryOf<G, Name>['deps']
		| RequiredBy<G, ReachWithin<G, EntryOf<G, Name>['deps'], EntryOf<G, Name>['child']>>,
		EntryOf<G, Name>['child']
	>,
	EntryOf<G, Name>['inputs']
>

type NonEmpty<T> = { readonly [K in keyof T as [T[K]] extends [never] ? never : K]: T[K] }

/** Reachable executions whose inputs are incomplete, with the slots they lack. */
export type MissingInputs<G extends Graph, Roots extends string> = NonEmpty<{
	readonly [E in ExecutionsIn<G, Reach<G, Roots>>]: MissingInputsOf<G, E>
}>

/** Names whose value the composition decides: bound, contributed to or overridden. */
type DecidedNames<G extends Graph> = {
	[K in keyof G]: G[K]['kind'] extends 'bound' | 'value' | 'many' | OverrideKind ? K : never
}[keyof G]

/** Reachable executions with inputs that are also bound at build(), which each run must supply instead. */
export type BoundInputs<G extends Graph, Roots extends string> = NonEmpty<{
	readonly [E in ExecutionsIn<G, Reach<G, Roots>>]: E extends keyof G
		? Extract<G[E]['inputs'], DecidedNames<G>>
		: never
}>

/** The names that depend on a given name. */
type DependentsOf<G extends Graph, Name extends string> = {
	[K in keyof G]: Name extends G[K]['deps'] ? K : never
}[keyof G]

/** `{ Logger: "Users" | "Mailer" }`: each missing slot with the nodes that need it. */
export type NeededBy<G extends Graph, Names extends string> = {
	readonly [N in Names]: DependentsOf<G, N>
}
