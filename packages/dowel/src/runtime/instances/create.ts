/** Creating cached instances: one per store in their scope, shared while in flight. */

import type { ServiceContext } from '../../api.ts'
import { type CachedPlan, isCached } from '../../compile/plan.ts'
import { DowelError, errorsOf, failuresOf, withCleanupFailures } from '../../errors.ts'
import { resolve } from '../resolve.ts'
import { cancelStore, onCancel } from '../store/cancel.ts'
import { cancellation, disposeRecords, isCancellation, markDisposed } from '../store/dispose.ts'
import {
	type Chain,
	type InstanceRecord,
	noop,
	type Store,
	storeAt,
	UNSET,
} from '../store/store.ts'
import { contextFor } from './context.ts'

/**
 * Initializes a scope's cached plans in dependency order, concurrently where
 * independent. The first failure stops what has not started and aborts what
 * is running; it is thrown once everything started has settled.
 */
export async function initialize(order: readonly CachedPlan[], chain: Chain): Promise<void> {
	const store = chain[chain.length - 1]!
	const started: Promise<unknown>[] = []
	const failures: unknown[] = []
	const fail = (error: unknown): void => {
		failures.push(error)
		if (failures.length === 1) cancelStore(store, () => afterFailure(store))
	}
	for (const plan of order) {
		try {
			const result = init(plan, chain)
			if (isPromiseLike(result)) {
				const promise = untilCancelled(Promise.resolve(result), plan, store)
				promise.then(undefined, fail)
				started.push(promise)
			}
		} catch (error) {
			fail(error)
			break
		}
	}
	await Promise.allSettled(started)
	if (failures.length > 0) throw initializationError(failures)
}

/** Why a store stops starting factories when one of them failed: a cancellation, but its own. */
function afterFailure(store: Store): DowelError {
	return cancellation(`Scope '${store.scope.name}' stopped starting services after one failed.`, {
		kind: 'failure',
		store,
	})
}

/** `promise`, until `waiter` is cancelled: a creation in a store above is shared, so a waiter leaves it running. */
function untilCancelled<T>(promise: Promise<T>, plan: CachedPlan, waiter: Store): Promise<T> {
	if (plan.scope === waiter.scope) return promise
	const reason = (): unknown =>
		cancellation(
			`Scope '${waiter.scope.name}' stopped starting services, so it no longer waits for '${plan.name}' in scope '${plan.scope.name}'.`,
		)
	return new Promise<T>((resolve, reject) => {
		const stop = onCancel(waiter, () => reject(reason()))
		promise.then(resolve, reject).finally(stop)
	})
}

/** The first failure, with what later ones add: not the cancellations it caused, nor itself reported again by a dependent. */
function initializationError(failures: readonly unknown[]): unknown {
	const [first, ...later] = failures
	const seen = new Set<unknown>(errorsOf(first))
	const more = later.flatMap(errorsOf).filter((error) => {
		if (seen.has(error) || isCancellation(error)) return false
		seen.add(error)
		return true
	})
	if (more.length === 0) return first
	return new AggregateError(
		[first, ...more],
		`Initialization failed, and ${more.length} more failure(s) followed.`,
	)
}

/** Starts creating a cached plan's instance unless it exists or is in flight; returns it or a promise of it. */
export function init(plan: CachedPlan, chain: Chain): unknown {
	const store = storeAt(plan, chain)
	const cached = store.cells[plan.cell]
	if (cached !== UNSET) return cached
	const inFlight = store.pending?.[plan.cell]
	if (inFlight !== undefined) return inFlight
	if (store.disposed) {
		throw new DowelError(
			'DISPOSED',
			`Service '${plan.name}' cannot be created because its container in scope '${plan.scope.name}' has been disposed.`,
		)
	}

	const record: InstanceRecord = {
		plan,
		owned: chain[0]!.owned,
		cleanups: [],
		disposed: false,
		controller: null,
	}
	store.starting.add(record)
	// Cached dependencies are created if nothing did yet, here or in a store above (on
	// demand), and waited for while they initialize; any other value, a bound promise included,
	// reaches the factory as it is.
	const values = new Array<unknown>(plan.deps.length)
	const waiting: Promise<void>[] = []
	try {
		for (let i = 0; i < plan.deps.length; i++) {
			const dep = plan.deps[i]!.plan
			if (!isCached(dep)) {
				values[i] = resolve(dep, chain)
				continue
			}
			const value = init(dep, chain)
			if (isPromiseLike(value)) {
				waiting.push(
					untilCancelled(Promise.resolve(value), dep, store).then((ready) => {
						values[i] = ready
					}),
				)
			} else {
				values[i] = value
			}
		}
	} catch (error) {
		// A dependency failed synchronously, so the factory never runs: nothing waits for what
		// was joined already, whose failures must not go unhandled.
		for (const promise of waiting) promise.catch(noop)
		abandon(store, record)
		throw error
	}
	const create = (): unknown => {
		// Its dependencies may have settled after a sibling's failure cancelled the store.
		if (store.cancelled) {
			abandon(store, record)
			throw cancellation(
				`Service '${plan.name}' was not created: its scope stopped starting services after a failure, a disposal or its caller's cancellation.`,
			)
		}
		let instance: unknown
		try {
			instance = construct(plan, values, contextFor(plan.name, record, store))
		} catch (error) {
			// Nothing adopted yet: fail synchronously, so the caller sees the error itself.
			if (record.cleanups.length === 0) {
				abandon(store, record)
				throw error
			}
			return remember(store, plan.cell, discard(store, record, error))
		}
		if (!isPromiseLike(instance)) return settle(store, plan.cell, record, instance)
		return remember(
			store,
			plan.cell,
			Promise.resolve(instance).then(
				(value) => settle(store, plan.cell, record, value),
				(error: unknown) => discard(store, record, error),
			),
		)
	}

	if (waiting.length === 0) return create()
	const created = Promise.all(waiting).then(create, (error: unknown) => {
		// A dependency failed, so the factory never runs.
		abandon(store, record)
		throw error
	})
	return remember(store, plan.cell, created)
}

/** Runs a service's factory with its dependencies by key, or collects a multi-binding's items. */
function construct(plan: CachedPlan, values: unknown[], ctx: ServiceContext): unknown {
	if (plan.kind === 'many') return values
	const deps: Record<string, unknown> = {}
	for (let i = 0; i < plan.deps.length; i++) deps[plan.deps[i]!.key] = values[i]
	return plan.factory(deps, ctx)
}

/** Keeps a finished instance, or disposes what it owns if its store went away meanwhile. */
function settle(store: Store, cell: number, record: InstanceRecord, instance: unknown): unknown {
	store.starting.delete(record)
	if (store.disposed) {
		return disposeRecords([record], `'${record.plan.name}', created after disposal`).then(() => {
			throw cancellation(
				`Service '${record.plan.name}' finished initializing after its owner was disposed.`,
			)
		})
	}
	store.cells[cell] = instance
	if (store.pending !== null) store.pending[cell] = undefined
	store.records.push(record)
	return instance
}

/** A factory failed: whatever it adopted before failing is disposed, and the failure carries any cleanup failure. */
async function discard(store: Store, record: InstanceRecord, error: unknown): Promise<never> {
	abandon(store, record)
	const what = `'${record.plan.name}' after a failed factory`
	throw withCleanupFailures(error, await failuresOf(() => disposeRecords([record], what)))
}

/** An instance that will never be kept: it stops counting as starting, and its signal aborts. */
function abandon(store: Store, record: InstanceRecord): void {
	store.starting.delete(record)
	markDisposed(record)
}

/** Remembers an in-flight creation so concurrent resolutions share it; a failed one is retried next time. */
function remember(store: Store, cell: number, promise: Promise<unknown>): Promise<unknown> {
	store.pending ??= new Array(store.cells.length)
	store.pending[cell] = promise
	promise.then(undefined, () => {
		if (store.pending?.[cell] === promise) store.pending[cell] = undefined
	})
	return promise
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { then?: unknown }).then === 'function'
	)
}
