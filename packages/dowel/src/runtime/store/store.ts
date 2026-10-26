/** Instance storage: one store per container, seen by a resolution as a chain indexed by scope depth. */

import type { CachedPlan, Plan } from '../../compile/plan.ts'
import { DowelError } from '../../errors.ts'
import { ROOT, type ScopeNode } from '../../nodes/node.ts'
import type { cancelStore } from './cancel.ts'

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
	/** In-flight initializations, by cell. Allocated on first async init. */
	pending: (Promise<unknown> | undefined)[] | null
	/** Instances whose factory has not settled yet; their signals abort when the store is cancelled. */
	readonly starting: Set<InstanceRecord>
	/**
	 * Set once the store stops starting factories, by a failure, a disposal or its caller.
	 * @see {@link cancelStore}
	 */
	cancelled: boolean
	/** Why it was cancelled, made when first asked; most cancellations are never observed. */
	why: (() => unknown) | null
	/** Called once it is cancelled; allocated when something first listens. */
	cancelListeners: ((why: () => unknown) => void)[] | null
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

/** The store of the container `build()` returns. */
export function rootStore(size: number): Store {
	return store(ROOT, size, new WeakSet(), null)
}

/** A store opened under `parent`: born cancelled if `parent` is. */
export function childStore(scope: ScopeNode, size: number, parent: Store): Store {
	return store(scope, size, parent.owned, parent)
}

function store(
	scope: ScopeNode,
	size: number,
	owned: WeakSet<object>,
	parent: Store | null,
): Store {
	return {
		scope,
		cells: new Array(size).fill(UNSET),
		pending: null,
		starting: new Set(),
		cancelled: parent?.cancelled ?? false,
		why: parent?.why ?? null,
		cancelListeners: null,
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

/** The store of `plan`'s scope in `chain`, which must see it. */
export function storeAt(plan: Plan, chain: Chain): Store {
	return chain[plan.scope.depth] ?? notVisible(plan.name, plan.scope)
}

/** The one message for "this node lives in a scope the current container cannot see". */
export function notVisible(name: string, scope: ScopeNode, from?: ScopeNode): never {
	throw new DowelError(
		'SCOPE_REQUIRED',
		`'${name}' lives in scope '${scope.name}'${from === undefined ? '' : `, which is not visible from '${from.name}'`}. Resolve it from a container opened for '${scope.name}'.`,
	)
}
