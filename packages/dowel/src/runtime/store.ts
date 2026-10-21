/**
 * Instance storage. Every container owns one store: the container `build()`
 * returns for scope `root`, and each opened container for its scope. A resolution sees a chain of stores, indexed by
 * scope depth.
 */

import type { CachedPlan } from '../compile/plan.ts'
import { DowelError } from '../errors.ts'
import type { ScopeNode } from '../nodes/node.ts'

export const UNSET: unique symbol = Symbol('dowel.unset')

/** Releases a resource, or runs a deferred callback. */
export type Disposer = () => void | PromiseLike<void>

/** One disposal step of an instance; `resource` is what it owns, if anything. */
interface Cleanup {
	readonly dispose: Disposer
	readonly resource: object | null
}

/** Disposal bookkeeping for one instance. */
export interface InstanceRecord {
	/** Re-pointed by hot replacement when the instance is carried into a new generation. */
	plan: CachedPlan
	/** The container-wide ownership set its resources are registered in. */
	readonly owned: WeakSet<object>
	readonly cleanups: Cleanup[]
	/** Set once its cleanups started running; its context refuses new resources from then on. */
	disposed: boolean
	/** Behind `ctx.signal`, created on first use; aborted when disposal of the instance starts. */
	controller: AbortController | null
}

/** Something a store owns and disposes before itself: an opened container or a running execution. */
export interface Child {
	/** Aborts the signals of the runs at and beneath it, without waiting for anything. */
	cancel(): void
	dispose(): Promise<void>
}

export interface Store {
	readonly scope: ScopeNode
	readonly cells: unknown[]
	/** In-flight initializations, by cell. Allocated on first async init. */
	pending: (Promise<unknown> | undefined)[] | null
	/** Instances whose factory has not settled yet; their signals abort when the store is disposed. */
	readonly starting: Set<InstanceRecord>
	/**
	 * Set once the store stops starting factories: its initialization failed,
	 * or its disposal began. A factory still waiting on its dependencies then
	 * never runs.
	 */
	cancelled: boolean
	/** Instantiated cached nodes in creation order. */
	readonly records: InstanceRecord[]
	/** Scopes and executions opened from this store, disposed before it. */
	readonly children: Set<Child>
	/** Every resource adopted anywhere in the container, to reject double ownership. */
	readonly owned: WeakSet<object>
	disposed: boolean
}

/** The stores a resolution can see: index `d` is the store at depth `d`. */
export type Chain = readonly Store[]

export function newStore(scope: ScopeNode, size: number, owned: WeakSet<object>): Store {
	return {
		scope,
		cells: new Array(size).fill(UNSET),
		pending: null,
		starting: new Set(),
		cancelled: false,
		records: [],
		children: new Set(),
		owned,
		disposed: false,
	}
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
