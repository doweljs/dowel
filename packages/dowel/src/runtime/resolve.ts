/**
 * Resolving plans against a chain of stores: creating cached instances,
 * opening containers and running executions. They share a module because they
 * recurse into each other: a run opens a container, whose initialization creates
 * instances, whose dependencies may be other executions.
 */

import type { RunContext, ServiceContext } from '../api.ts'
import {
	type CachedPlan,
	type ExecutionPlan,
	isCached,
	type Plan,
	type ScopeNeeds,
	type ScopePlan,
} from '../compile/plan.ts'
import { DowelError, errorsOf, failuresOf, withCleanup, withCleanupFailures } from '../errors.ts'
import type { BindingNode } from '../nodes/node.ts'
import { cancelStore, onCancel } from './cancel.ts'
import { contextFor } from './context.ts'
import {
	cancellation,
	cancelledBy,
	disposeRecords,
	disposeStore,
	isCancellation,
	markDisposed,
	rewordCancellation,
} from './dispose.ts'
import {
	type Chain,
	type Child,
	childStore,
	type InstanceRecord,
	noop,
	notVisible,
	type Store,
	UNSET,
} from './store.ts'
import { supply } from './supply.ts'

/** Resolves a plan's value synchronously, throwing if an async instance is not ready. */
export function resolve(plan: Plan, chain: Chain): unknown {
	switch (plan.kind) {
		case 'value':
			return plan.value
		case 'scopeValue': {
			const value = storeOf(plan, chain).cells[plan.cell]
			return value === UNSET ? undefined : value
		}
		case 'execution':
			return runner(plan, chain)
		case 'service':
		case 'many': {
			const result = init(plan, chain)
			if (!isPromiseLike(result)) return result
			throw new DowelError(
				'NOT_READY',
				`Service '${plan.name}' is not ready: its initialization is still in flight or failed. Resolve it only after build() or open() resolved.`,
			)
		}
	}
}

/**
 * Initializes a scope's cached plans in dependency order, and what they reach
 * above it that nothing created yet. Independent async factories start
 * concurrently. The first failure, synchronous or not, stops what has not
 * started and aborts the signals of what is still running; once everything
 * started has settled, it is thrown with what later failures add, and the
 * caller disposes what was created.
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
				const promise = joined(Promise.resolve(result), plan, store)
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

/**
 * Whether a store was cancelled from outside, rather than by a failure of its
 * own initialization: a disposal, its caller, or a failure in a store above.
 */
function cancelledFromOutside(store: Store): boolean {
	if (!store.cancelled) return false
	const by = cancelledBy(store.why!())
	return !(by?.kind === 'failure' && by.store === store)
}

/** Why a signal aborted; a polyfill may leave `reason` unset, which the platform never does. */
function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
}

/**
 * What `waiter`'s store waits for while `plan` is created. A store above
 * shares what it creates, so a waiter that stops starting services stops
 * waiting for it instead of cancelling it, and leaves it to the store that
 * owns it.
 */
function joined<T>(promise: Promise<T>, plan: CachedPlan, waiter: Store): Promise<T> {
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

/**
 * The first failure in time, which is the cause, with what later failures
 * add: their own errors and cleanup failures, but neither the cancellations
 * the first caused nor the same error again as a dependent reported it.
 */
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

/** A store opened under a parent, which disposes it with itself unless it was disposed first. */
export interface OpenedStore extends Child {
	readonly chain: Chain
}

/** How the owner of an opened store takes part in opening and disposing it. */
export interface OpenOptions {
	/** Cancels the store, and what is opened beneath it, while it is open. */
	readonly signal?: AbortSignal | undefined
	/** Runs before the store's instances are disposed. */
	readonly beforeDisposal?: () => Promise<void>
}

/**
 * Opens a store at `scopePlan` under the last store of `chain`: supplies the
 * bindings, registers it with its parent and initializes what `needs` lists.
 * Its cancellation follows its parent's, so it is born cancelled under a
 * cancelled one. On failure the store is disposed before the promise rejects;
 * cancelled while it opens, it rejects with why.
 */
export async function openStore(
	chain: Chain,
	scopePlan: ScopePlan,
	bindings: readonly BindingNode[],
	needs: ScopeNeeds,
	{ signal, beforeDisposal }: OpenOptions = {},
): Promise<OpenedStore> {
	// A store being disposed may already have disposed its children, so nothing may open under it.
	if (chain.some((store) => store.disposed)) {
		throw new DowelError(
			'DISPOSED',
			`Scope '${scopePlan.scope.name}' cannot be opened because the container it would open from has been disposed.`,
		)
	}
	if (signal?.aborted) throw abortReason(signal)
	const parent = chain[chain.length - 1]!
	const store = childStore(scopePlan.scope, scopePlan.cells, parent)
	supply(scopePlan, store, bindings, needs.required)
	const stop = (): void => cancelStore(store, () => abortReason(signal!))
	signal?.addEventListener('abort', stop)
	let disposal: Promise<void> | null = null
	const opened: OpenedStore = {
		chain: [...chain, store],
		store,
		dispose: () => {
			disposal ??= (async () => {
				try {
					// What runs beneath it hears of the disposal before anything is waited for.
					cancelStore(store, () =>
						cancellation(`Scope '${scopePlan.scope.name}' is being disposed.`),
					)
					await beforeDisposal?.()
					await disposeStore(store, 'the opened container')
				} finally {
					signal?.removeEventListener('abort', stop)
					// Detaching only once disposed lets a parent disposed meanwhile wait for it.
					parent.children.delete(opened)
				}
			})()
			return disposal
		},
	}
	parent.children.add(opened)
	await withCleanup(
		async () => {
			try {
				if (store.cancelled) throw store.why!()
				await initialize(needs.order, opened.chain)
				// Disposed or cancelled while its factories ran: what was created is torn down, not handed out.
				if (store.cancelled) throw store.why!()
			} catch (error) {
				if (!cancelledFromOutside(store)) throw error
				// Cancelled: it rejects with why, which its owner words, and with what failed for
				// another reason than the abort.
				const reason = store.why!()
				throw withCleanupFailures(
					reason,
					errorsOf(error).filter(
						(failure) => failure !== reason && !isCancellation(failure) && !isAbort(failure),
					),
					`Opening scope '${scopePlan.scope.name}'`,
				)
			}
		},
		() => opened.dispose(),
	)
	return opened
}

// ---------------------------------------------------------------------------
// Cached instances
// ---------------------------------------------------------------------------

/** Starts creating a cached plan's instance unless it exists or is in flight; returns it or a promise of it. */
function init(plan: CachedPlan, chain: Chain): unknown {
	const store = storeOf(plan, chain)
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
	// demand), and joined while they initialize; any other value, a bound promise included,
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
					joined(Promise.resolve(value), dep, store).then((ready) => {
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
			return track(store, plan.cell, discard(store, record, error))
		}
		if (!isPromiseLike(instance)) return settle(store, plan.cell, record, instance)
		return track(
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
	return track(store, plan.cell, created)
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

/** Remembers an in-flight initialization so concurrent resolutions share it. */
function track(store: Store, cell: number, promise: Promise<unknown>): Promise<unknown> {
	store.pending ??= new Array(store.cells.length)
	store.pending[cell] = promise
	// A failed initialization is retried on the next resolution.
	promise.then(undefined, () => {
		if (store.pending?.[cell] === promise) store.pending[cell] = undefined
	})
	return promise
}

// ---------------------------------------------------------------------------
// Executions
// ---------------------------------------------------------------------------

/** The function a dependent receives for an execution, bound to the stores down to the execution's scope. */
function runner(plan: ExecutionPlan, chain: Chain): (...args: unknown[]) => Promise<unknown> {
	const baseLength = plan.scope.depth + 1
	const base: Chain = chain.slice(0, baseLength)
	if (base.length < baseLength) notVisible(plan.name, plan.scope)
	return (...args) => run(plan, base, args)
}

/** Runs once under `base`: opens the run's container, hands the entry to the body, and disposes the container. */
async function run(plan: ExecutionPlan, base: Chain, args: readonly unknown[]): Promise<unknown> {
	const { name } = plan
	const [values, body, options] =
		plan.inputs.length === 0 ? [{}, args[0], args[1]] : [args[0], args[1], args[2]]
	if (typeof body !== 'function' || typeof values !== 'object' || values === null) {
		throw new DowelError(
			'INVALID_NODE',
			plan.inputs.length === 0
				? `Execution '${name}' must be called with a body function.`
				: `Execution '${name}' must be called with an object of its inputs followed by a body function.`,
		)
	}
	const signal = signalOption(name, options)
	const bindings = inputBindings(plan, values)
	// The parent owns the run, not just its container: disposing the parent cancels the run and
	// waits for the body before the run's container, and then the parent, are disposed. The body
	// counts as running from just before it is called, so one that starts disposing its owner
	// synchronously is still waited for.
	let phase: 'opening' | Promise<void> | 'settled' = 'opening'
	// Why the body never started: a disposal or a failure above, worded for this run, or the
	// reason its caller cancelled it with.
	const notStarted = (reason: unknown): unknown => {
		const by = cancelledBy(reason)
		if (by === undefined) return reason
		return cancellation(
			by.kind === 'failure'
				? `Execution '${name}' did not start: ${(reason as Error).message}`
				: `Execution '${name}' was disposed before its body started.`,
			by,
			{ cause: reason },
		)
	}
	const opened = await openStore(base, plan.child, bindings, plan.needs, {
		signal,
		beforeDisposal: async () => {
			if (typeof phase === 'object') await phase
		},
	}).catch((error: unknown) =>
		// Cancellation stopped the opening: the run reports that, with what else failed.
		rewordCancellation(error, notStarted, `Execution '${name}'`),
	)
	const { store } = opened
	// Cancelled before the body could start: the body never starts.
	if (store.cancelled) {
		throw withCleanupFailures(
			notStarted(store.why!()),
			await failuresOf(() => opened.dispose()),
			`Execution '${name}'`,
		)
	}
	const context = new BodyContext(store, name)
	const value = await withCleanup(
		async () => {
			let settle = noop
			phase = new Promise<void>((resolve) => {
				settle = resolve
			})
			try {
				return await body(resolve(plan.entry, opened.chain), context)
			} finally {
				context.settle()
				settle()
				phase = 'settled'
			}
		},
		() => opened.dispose(),
		`Execution '${name}'`,
	)
	await opened.dispose()
	return value
}

/**
 * What a run's body receives besides the entry. Its signal follows the run's
 * cancellation until the body settles, after which disposing the run's
 * container is the run finishing; it is created only if read. Once settled,
 * it lets go of the run, so a body that keeps it keeps nothing else alive.
 */
class BodyContext implements RunContext {
	private controller: AbortController | null = null
	private unfollow = noop

	constructor(
		private store: Store | null,
		private readonly name: string,
	) {}

	get signal(): AbortSignal {
		if (this.controller === null) {
			const controller = new AbortController()
			this.controller = controller
			const { name } = this
			if (this.store !== null) {
				this.unfollow = onCancel(this.store, (why) => controller.abort(runReason(name, why())))
			}
		}
		return this.controller.signal
	}

	settle(): void {
		this.unfollow()
		this.store = null
	}
}

/** Why a body's signal aborts: a disposal, worded for its run with the scope's as its cause, or its caller's reason. */
function runReason(name: string, reason: unknown): unknown {
	const by = cancelledBy(reason)
	if (by === undefined) return reason
	return cancellation(`Execution '${name}' is being disposed.`, by, { cause: reason })
}

/**
 * The `signal` a run was called with, checked by shape rather than class, so
 * that a signal from another realm or a polyfill works too.
 */
function signalOption(name: string, options: unknown): AbortSignal | undefined {
	if (options === undefined) return undefined
	if (typeof options === 'object' && options !== null) {
		const { signal } = options as { signal?: unknown }
		if (signal === undefined || isSignal(signal)) return signal
	}
	throw new DowelError(
		'INVALID_NODE',
		`Execution '${name}' was called with options that are not an object with an AbortSignal 'signal'.`,
	)
}

function isSignal(value: unknown): value is AbortSignal {
	if (typeof value !== 'object' || value === null) return false
	const signal = value as Partial<Record<keyof AbortSignal, unknown>>
	return (
		typeof signal.aborted === 'boolean' &&
		typeof signal.addEventListener === 'function' &&
		typeof signal.removeEventListener === 'function'
	)
}

/** Whether an error is how work reports being aborted, as `fetch` and `AbortSignal` do. */
function isAbort(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { name?: unknown }).name === 'AbortError'
	)
}

/** Value bindings for a run's inputs, checked against the keys the execution declares. */
function inputBindings(plan: ExecutionPlan, values: object): BindingNode[] {
	const keys = new Set(plan.inputs.map((input) => input.key))
	const unknown = Object.keys(values).find((key) => !keys.has(key))
	if (unknown !== undefined) {
		throw new DowelError(
			'INVALID_NODE',
			`Execution '${plan.name}' has no input '${unknown}'. Its inputs are ${[...keys].map((key) => `'${key}'`).join(', ')}.`,
		)
	}
	return plan.inputs.map(({ key, slot }) => {
		if (!Object.hasOwn(values, key)) {
			throw new DowelError(
				'MISSING_SCOPE_VALUE',
				`Execution '${plan.name}' needs a value for its input '${key}' (slot '${slot.name}').`,
			)
		}
		return {
			kind: 'binding',
			slot,
			impl: { kind: 'value', value: (values as Record<string, unknown>)[key] },
		}
	})
}

// ---------------------------------------------------------------------------

function storeOf(plan: Plan, chain: Chain): Store {
	return chain[plan.scope.depth] ?? notVisible(plan.name, plan.scope)
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { then?: unknown }).then === 'function'
	)
}
