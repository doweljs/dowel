/**
 * What the runtime lets `@doweljs/core/hot` plug into. Kept apart from the
 * replacement algorithm, which is only bundled when `@doweljs/core/hot` is imported;
 * until then every hook leaves things as they are.
 */

import type { NodeInfo } from '../api.ts'
import { type Canonicalize, type Composition, compile } from '../compile/compile.ts'
import type { Compiled, ExecutionPlan } from '../compile/plan.ts'
import type { Chain, Store } from './store.ts'

/** Marks a container's hot-replacement internals; distinct from `internal`, which marks graph nodes. */
export const hotAccess: unique symbol = Symbol('dowel.hot')

/** The mutable internals that hot replacement operates on. */
export interface HotAccess {
	/** Stable identity of the container across rebuilds. */
	readonly serial: number
	readonly composition: Composition
	readonly compiled: Compiled
	readonly root: Store
	/** Whether the container's first initialization has settled; until then it cannot be replaced. */
	readonly initialized: boolean
	/** Settles once the first initialization has. */
	readonly ready: Promise<void>
	swap(compiled: Compiled, root: Store): void
	/** Work on the container's generations that disposing the container must wait for. */
	track(work: Promise<unknown>): void
}

export interface TrackedContainer {
	readonly [hotAccess]: HotAccess
	inspect(): readonly NodeInfo[]
}

export interface Hooks {
	/** Whether containers are tracked. */
	enabled: boolean
	readonly containers: TrackedContainers
	/** Maps a node to the latest declaration of its name. */
	canonical: Canonicalize
	/** Makes plans reachable through every object that ever carried a node's name. */
	withAliases: (compiled: Compiled) => Compiled
	/**
	 * The plan and stores a runner resolved from `base` runs with now: a
	 * runner that outlives the generation it was resolved from follows it to
	 * the latest one.
	 */
	follow: (plan: ExecutionPlan, base: Chain) => [ExecutionPlan, Chain]
}

/**
 * Live containers, held weakly: a container dropped without being disposed
 * is neither kept alive nor rebuilt on every later update.
 */
export class TrackedContainers {
	private readonly refs = new Set<WeakRef<TrackedContainer>>()
	private readonly byContainer = new WeakMap<TrackedContainer, WeakRef<TrackedContainer>>()
	private readonly finalizer = new FinalizationRegistry<WeakRef<TrackedContainer>>((ref) =>
		this.refs.delete(ref),
	)

	add(container: TrackedContainer): void {
		const ref = new WeakRef(container)
		this.refs.add(ref)
		this.byContainer.set(container, ref)
		this.finalizer.register(container, ref, ref)
	}

	delete(container: TrackedContainer): void {
		const ref = this.byContainer.get(container)
		if (ref === undefined) return
		this.refs.delete(ref)
		this.byContainer.delete(container)
		this.finalizer.unregister(ref)
	}

	*[Symbol.iterator](): IterableIterator<TrackedContainer> {
		for (const ref of this.refs) {
			const container = ref.deref()
			if (container !== undefined) yield container
		}
	}
}

export const hooks: Hooks = {
	enabled: false,
	containers: new TrackedContainers(),
	canonical: (node) => node,
	withAliases: (compiled) => compiled,
	follow: (plan, base) => [plan, base],
}

/** Compiles a composition against the latest declarations, reachable through every earlier one. */
export function compileWithHooks(composition: Composition): Compiled {
	return hooks.withAliases(compile(composition, { canonical: hooks.canonical }))
}
