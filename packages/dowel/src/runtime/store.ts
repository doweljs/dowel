/**
 * Instance storage. Every container owns one store: the container `build()`
 * returns for scope `root`, and each opened container for its scope. A
 * resolution sees a chain of stores, indexed by scope depth.
 */

import type { CachedPlan } from '../compile/plan.ts'
import { DowelError } from '../errors.ts'
import { ROOT, type ScopeNode } from '../nodes/node.ts'
import type { Effect, Generation } from './generation.ts'

export const UNSET: unique symbol = Symbol('dowel.unset')

export const noop = (): void => {}

/** Releases a resource, or runs a deferred callback. */
export type Disposer = () => void | PromiseLike<void>

/** One disposal step of an instance; `resource` is what it owns, if anything. */
interface Cleanup {
	readonly dispose: Disposer
	readonly resource: object | null
}

/** Disposal bookkeeping for one instance. */
export interface InstanceRecord {
	readonly plan: CachedPlan
	/** The container-wide ownership set its resources are registered in. */
	readonly owned: WeakSet<object>
	readonly cleanups: Cleanup[]
	/** Set once its cleanups started running; its context refuses new resources from then on. */
	disposed: boolean
	/** Behind `ctx.signal`, created on first use; aborted when disposal of the instance starts. */
	controller: AbortController | null
	/** What `ctx.whileActive()` registered, if anything: one effect per instance. */
	effect: Effect | null
	/** Until its factory has returned, or settled: the only time it may register an effect. */
	constructing: boolean
}

/** Something a store owns and disposes before itself: an opened container or a running execution. */
export interface Child {
	/** Its own store, which a cancellation of its owner's reaches. */
	readonly store: Store
	dispose(): Promise<void>
}

export interface Store {
	readonly scope: ScopeNode
	readonly cells: unknown[]
	/** The generation of the container the chain belongs to, shared by every store in it. */
	readonly generation: Generation
	/** In-flight initializations, by cell. Allocated on first async init. */
	pending: (Promise<unknown> | undefined)[] | null
	/** Instances whose factory has not settled yet; their signals abort when the store is cancelled. */
	readonly starting: Set<InstanceRecord>
	/**
	 * Set once the store stops starting factories: its initialization failed,
	 * its disposal or an owner's began, or the caller of its run gave up. A
	 * factory still waiting on its dependencies then never runs, and what
	 * waits on a store above stops waiting. See `cancel.ts`.
	 */
	cancelled: boolean
	/**
	 * Why it was cancelled, made when first asked, since most cancellations,
	 * such as a run finishing, are never observed; `null` until then.
	 */
	why: (() => unknown) | null
	/** Called once it is cancelled; allocated when something first listens. */
	cancelListeners: ((why: () => unknown) => void)[] | null
	/** Instantiated cached nodes in creation order. */
	readonly records: InstanceRecord[]
	/** Scopes and executions opened from this store, disposed before it. */
	readonly children: Set<Child>
	/** Called once the last child detaches; set by a superseded container waiting for its work to drain. */
	drained: (() => void) | null
	/** Every resource adopted anywhere in the container, to reject double ownership. */
	readonly owned: WeakSet<object>
	disposed: boolean
}

/** The stores a resolution can see: index `d` is the store at depth `d`. */
export type Chain = readonly Store[]

/** The store of a container that `build()` or a candidate creates. */
export function rootStore(size: number, generation: Generation): Store {
	return store(ROOT, size, generation, new WeakSet(), null)
}

/** A store opened under `parent`: born cancelled if `parent` is. */
export function childStore(scope: ScopeNode, size: number, parent: Store): Store {
	return store(scope, size, parent.generation, parent.owned, parent)
}

function store(
	scope: ScopeNode,
	size: number,
	generation: Generation,
	owned: WeakSet<object>,
	parent: Store | null,
): Store {
	return {
		scope,
		cells: new Array(size).fill(UNSET),
		generation,
		pending: null,
		starting: new Set(),
		cancelled: parent?.cancelled ?? false,
		why: parent?.why ?? null,
		cancelListeners: null,
		records: [],
		children: new Set(),
		drained: null,
		owned,
		disposed: false,
	}
}

/** Forgets a child once it is disposed, and tells whoever waits for the store to drain. */
export function detach(store: Store, child: Child): void {
	store.children.delete(child)
	if (store.children.size === 0) store.drained?.()
}

/** Forgets every instance. Disposal must have happened already. */
export function clearStore(store: Store): void {
	store.records.length = 0
	store.cells.fill(UNSET)
}

/** The one message for "this node lives in a scope the current container cannot see". */
export function notVisible(name: string, scope: ScopeNode, from?: ScopeNode): never {
	throw new DowelError(
		'SCOPE_REQUIRED',
		`'${name}' lives in scope '${scope.name}'${from === undefined ? '' : `, which is not visible from '${from.name}'`}. Resolve it from a container opened for '${scope.name}'.`,
	)
}
