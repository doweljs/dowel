/** The public interfaces the runtime implements. */

import type { DeclaredScope } from './model/checks.ts'
import type {
	AnyBinding,
	AnyExecution,
	AnyScope,
	AnyService,
	AnySlot,
	Binding,
	RootMeta,
	ScopeMeta,
	ServiceMeta,
	Slot,
	SlotMeta,
} from './model/declarations.ts'
import type {
	CompositionIssues,
	IncompleteExecutions,
	InputsBoundAtBuild,
	MissingBindings,
} from './model/diagnostics.ts'
import type { NeededBy } from './model/graph.ts'
import type { BindingMetaOf, Impl, ImplAt, MetaOf } from './model/infer.ts'
import type {
	BoundExecutionInputs,
	BoundNames,
	ChildCheck,
	ContainerState,
	GetResult,
	Issues,
	KnownLength,
	Missing,
	MissingExecutionInputs,
	OpenCheck,
	Overridable,
	Override,
	Providable,
	Provide,
	ProvideAll,
	Resolvable,
	TargetOf,
} from './model/state.ts'
import type { Simplify } from './model/util.ts'
/**
 * The context handed to every factory. It mirrors `AsyncDisposableStack`:
 * a factory owns what it adopts, and nothing else.
 */
export interface ServiceContext {
	/**
	 * Adopt a resource that implements `Symbol.dispose` or `Symbol.asyncDispose`
	 * and return it. It is disposed with the instance.
	 *
	 * ```ts
	 * const client = ctx.use(await connect(url))
	 * ```
	 */
	use<T extends Disposable | AsyncDisposable>(resource: T): T
	/** Adopt any value with an explicit disposer and return it. */
	adopt<T>(resource: T, dispose: (resource: T) => void | PromiseLike<void>): T
	/** Run a callback when the instance is disposed. */
	defer(dispose: () => void | PromiseLike<void>): void
	/**
	 * Aborted when disposal of the instance starts, or of its owner while the
	 * factory is still running. Disposal waits for a running factory, so pass
	 * this to slow startup work (connects, fetches) to let it stop promptly.
	 *
	 * ```ts
	 * const client = ctx.use(await connect(url, { signal: ctx.signal }))
	 * ```
	 */
	readonly signal: AbortSignal
}

/** What a run's body receives besides the entry. */
export interface RunContext {
	/**
	 * Aborted when the container the runner was resolved from is disposed while
	 * the body runs, or when the caller's `signal` aborts, with its reason.
	 * Disposal waits for the body to settle, so a long-running body should stop
	 * when this aborts.
	 */
	readonly signal: AbortSignal
}

/** What a caller may pass a runner after the body. */
export interface RunOptions {
	/**
	 * Cancels the run. Aborted before the body starts, the run creates nothing
	 * more in its scope, disposes what it created and rejects with the
	 * signal's reason; what it waits for in scopes above keeps going for
	 * whoever shares it. Aborted while the body runs, it aborts the body's
	 * signal and what the run opened beneath it; the run still waits for the
	 * body and settles as the body does.
	 */
	readonly signal?: AbortSignal | undefined
}

/** How a node's value arrives, as reported by `inspect()`. */
export type NodeBinding =
	| { readonly kind: 'service'; readonly name: string }
	| { readonly kind: 'value' }
	| { readonly kind: 'scope' }
	| { readonly kind: 'absent' }
	| {
			readonly kind: 'many'
			readonly items: readonly (
				| { readonly kind: 'service'; readonly name: string }
				| { readonly kind: 'value' }
			)[]
	  }

/** A node of a built container, as reported by `inspect()`. */
export interface NodeInfo {
	readonly name: string
	readonly kind: 'service' | 'slot' | 'execution'
	readonly scope: string
	readonly many: boolean
	readonly deps: readonly { readonly key: string; readonly name: string }[]
	readonly binding: NodeBinding | null
	/** Instance state for cached nodes visible from here; `null` otherwise. */
	readonly status: 'idle' | 'pending' | 'ready' | null
}

/**
 * An immutable description of a container. Every method returns a new
 * builder, so partial compositions can be shared and extended freely.
 */
export interface ContainerBuilder<S extends ContainerState> {
	/**
	 * Add roots and bindings. Services, executions and slots given here are
	 * activated at `build()` together with what they reach outside an
	 * execution; what only an execution reaches is created by the first run
	 * that needs it. Bindings only make implementations available and are
	 * activated when reached.
	 */
	provide<const I extends readonly Providable[]>(
		...items: I & KnownLength<I>
	): ContainerBuilder<ProvideAll<S, I>>

	/** Shorthand for `provide(bind(slot, impl))`. */
	bind<T, TM extends SlotMeta, const I extends Impl<T, TM>>(
		slot: Slot<T, TM>,
		impl: I,
	): ContainerBuilder<Provide<S, Binding<T, BindingMetaOf<TM, I>>>>

	/** Contribute one item to a multi-binding slot. The same as `bind()` for such slots, named for clarity. */
	contribute<T, TM extends SlotMeta & { readonly many: true }, const I extends Impl<T, TM>>(
		slot: Slot<T, TM>,
		impl: I,
	): ContainerBuilder<Provide<S, Binding<T, BindingMetaOf<TM, I>>>>

	/**
	 * Replace a node in the graph. Dependents receive the replacement; the
	 * original is never instantiated, and nothing that only it needed is
	 * required any more. Intended for tests and environment specific swaps.
	 * A service must be reachable from what is provided and a slot must be
	 * bound by the time `build()` is called, in any order.
	 */
	override<T, M extends ServiceMeta | SlotMeta, const I extends NoInfer<T> | ImplAt<T, M>>(
		target: Overridable<T, M>,
		impl: I,
	): ContainerBuilder<Override<S, TargetOf<M>, I>>

	/**
	 * Apply a reusable composition function. Write it generic in the state so
	 * it applies at any point of a chain:
	 *
	 * ```ts
	 * const infra = <S extends ContainerState>(b: ContainerBuilder<S>) => b.bind(Logger, Pino).provide(Db)
	 * container().with(infra).provide(Users).build()
	 * ```
	 */
	with<R>(compose: (builder: this) => R): R

	/**
	 * Build the container: activate every root and what it reaches, awaiting
	 * async factories. Only callable once the composition has no issues,
	 * every reachable root-scope slot is bound and every execution's inputs
	 * are complete. If construction fails, everything created is disposed
	 * before the returned promise rejects.
	 */
	readonly build: [Issues<S>] extends [never]
		? [Missing<S>] extends [never]
			? [keyof MissingExecutionInputs<S>] extends [never]
				? [keyof BoundExecutionInputs<S>] extends [never]
					? () => Promise<Container<S>>
					: InputsBoundAtBuild<Simplify<BoundExecutionInputs<S>>>
				: IncompleteExecutions<Simplify<MissingExecutionInputs<S>>>
			: MissingBindings<Simplify<NeededBy<S['graph'], Missing<S>>>>
		: CompositionIssues<Issues<S>>
}

/**
 * A container: the one `build()` returns, for the `root` scope, or one opened
 * from it for a child scope with `open()`. Each sees its own scope and every
 * scope above it.
 */
export interface Container<
	S extends ContainerState = ContainerState,
	Current extends ScopeMeta = RootMeta,
	/** Slots supplied to `open()` for this container and those it was opened from. */
	Supplied extends string = never,
> extends AsyncDisposable {
	/**
	 * Resolve a node visible from this scope that the container created with
	 * itself: one provided, or reached from one outside an execution. Always
	 * synchronous.
	 */
	get<N extends AnyService | AnySlot | AnyExecution>(
		node: Resolvable<N, S, Current>,
	): GetResult<N, S, Supplied>

	/**
	 * Open a container for a child scope. Required slots of that scope must be
	 * supplied as value bindings. What the provided nodes reach in that scope
	 * is initialized before the promise resolves; on failure it is disposed
	 * first. What only executions reach is created when a run needs it.
	 */
	open<Sc extends AnyScope, const B extends readonly AnyBinding[]>(
		scope: Sc & DeclaredScope<Sc> & ChildCheck<Current, Sc> & OpenCheck<S, MetaOf<Sc>['name'], B>,
		...bindings: B
	): Promise<Container<S, MetaOf<Sc>, Supplied | BoundNames<B>>>

	/** Describe every node in the graph and the state of instances visible from here. Throws `DISPOSED` once the container is disposed. */
	inspect(): readonly NodeInfo[]

	/** Dispose every container and execution opened from here, then every instance, in reverse creation order. */
	dispose(): Promise<void>
}
