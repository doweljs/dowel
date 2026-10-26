/** The public interfaces the runtime implements. */

import type { DeclaredName, DeclaredScope } from './model/checks.ts'
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
import type { BindingMetaOf, Impl, ImplAt, MetaOf } from './model/infer.ts'
import type {
	BoundNames,
	BuildSignature,
	ChildCheck,
	ContainerState,
	GetResult,
	KnownLength,
	OpenCheck,
	Overridable,
	Override,
	Providable,
	Provide,
	ProvideAll,
	Resolvable,
	TargetOf,
} from './model/state.ts'
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
	 * Aborted when disposal of the instance starts, even while its factory
	 * still runs. Pass it to slow startup work, which disposal waits for.
	 *
	 * ```ts
	 * const client = ctx.use(await connect(url, { signal: ctx.signal }))
	 * ```
	 */
	readonly signal: AbortSignal
}

/** What a run's body receives besides the entry. */
export interface RunContext {
	/** Aborted when the run's container is disposed or its caller's `signal` aborts. Disposal waits for the body, so stop when it does. */
	readonly signal: AbortSignal
}

/** What a caller may pass a runner after the body. */
export interface RunOptions {
	/**
	 * Cancels the run. Before the body starts, the run disposes what it created
	 * and rejects with the signal's reason; while the body runs, the body's
	 * signal aborts and the run settles as the body does.
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

/** An immutable description of a container; every method returns a new builder. */
export interface ContainerBuilder<S extends ContainerState> {
	/**
	 * Add roots and bindings. Roots and what they reach outside an execution
	 * are created at `build()`; bindings take effect when reached.
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
	 * Replace a node in the graph: the original is never created and nothing
	 * only it needed is required. The target must be reachable, or bound for
	 * a slot, by `build()`.
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
	 * Build the container, creating every root and what it reaches. Callable
	 * once the composition is complete; on failure, what was created is
	 * disposed before the promise rejects.
	 */
	readonly build: BuildSignature<S>
}

/** A container, for the `root` scope or one opened for a child scope; it sees its scope and those above. */
export interface Container<
	S extends ContainerState = ContainerState,
	Current extends ScopeMeta = RootMeta,
	/** Slots supplied to `open()` for this container and those it was opened from. */
	Supplied extends string = never,
> extends AsyncDisposable {
	/** Resolve a node this container created with itself. Always synchronous. */
	get<N extends AnyService | AnySlot | AnyExecution>(
		node: Resolvable<N, S, Current>,
	): GetResult<N, S, Supplied>

	/**
	 * Open a container for a child scope, with its required slots bound to
	 * values. What the roots reach there is created before the promise
	 * resolves; on failure it is disposed first.
	 */
	open<Sc extends AnyScope, const B extends readonly AnyBinding[]>(
		scope: Sc & DeclaredScope<Sc> & ChildCheck<Current, Sc> & OpenCheck<S, MetaOf<Sc>['name'], B>,
		...bindings: B & DeclaredName<B[number]>
	): Promise<Container<S, MetaOf<Sc>, Supplied | BoundNames<B>>>

	/** Describe every node in the graph and the state of instances visible from here. Throws `DISPOSED` once the container is disposed. */
	inspect(): readonly NodeInfo[]

	/** Dispose every container and execution opened from here, then every instance, in reverse creation order. */
	dispose(): Promise<void>
}
