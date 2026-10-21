/**
 * Resolving plans against a chain of stores: creating cached instances,
 * opening containers and running executions. They share a module because they
 * recurse into each other: a run opens a container, whose initialization creates
 * instances, whose dependencies may be other executions.
 */

import type { ServiceContext } from '../api.ts'
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
import { contextFor } from './context.ts'
import {
	cancellation,
	cancelStarting,
	cancelStore,
	disposeRecords,
	disposeStore,
	isCancellation,
	markDisposed,
} from './dispose.ts'
import { hooks } from './hooks.ts'
import {
	type Chain,
	type Child,
	type InstanceRecord,
	newStore,
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
 * Initializes a scope's cached plans in dependency order. Independent async
 * factories start concurrently. The first failure, synchronous or not, stops
 * what has not started and aborts the signals of what is still running; once
 * everything started has settled, it is thrown with what later failures add,
 * and the caller disposes what was created.
 */
export async function initialize(order: readonly CachedPlan[], chain: Chain): Promise<void> {
	const store = chain[chain.length - 1]!
	const started: Promise<unknown>[] = []
	const failures: unknown[] = []
	const fail = (error: unknown): void => {
		failures.push(error)
		if (failures.length === 1) cancelStarting(store)
	}
	for (const plan of order) {
		try {
			const result = init(plan, chain)
			if (isPromiseLike(result)) {
				const promise = Promise.resolve(result)
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

/**
 * Creates plans in a store shared beyond one run, on demand: the instances
 * belong to that store, which keeps them for later runs and disposes them
 * with itself. Unlike `initialize`, a failure does not stop the store from
 * starting factories, since others share it; the failed plan is created again
 * on the next demand.
 */
async function createShared(order: readonly CachedPlan[], chain: Chain): Promise<void> {
	const started: Promise<unknown>[] = []
	const failures: unknown[] = []
	for (const plan of order) {
		try {
			const result = init(plan, chain)
			if (isPromiseLike(result)) {
				started.push(Promise.resolve(result).then(undefined, (error) => void failures.push(error)))
			}
		} catch (error) {
			failures.push(error)
			break
		}
	}
	await Promise.all(started)
	if (failures.length > 0) throw initializationError(failures)
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

/**
 * Opens a store at `scopePlan` under the last store of `chain`: supplies the
 * bindings, registers it with its parent and initializes what `needs` lists.
 * `onCancel` runs when disposal of it or an owner starts, and `beforeDisposal`
 * before its instances are disposed. On failure the store is disposed before
 * the promise rejects.
 */
export async function openStore(
	chain: Chain,
	scopePlan: ScopePlan,
	bindings: readonly BindingNode[],
	needs: ScopeNeeds,
	onCancel?: () => void,
	beforeDisposal?: () => Promise<void>,
): Promise<OpenedStore> {
	// A store being disposed may already have disposed its children, so nothing may open under it.
	if (chain.some((store) => store.disposed)) {
		throw new DowelError(
			'DISPOSED',
			`Scope '${scopePlan.scope.name}' cannot be opened because the container it would open from has been disposed.`,
		)
	}
	const parent = chain[chain.length - 1]!
	const store = newStore(scopePlan.scope, scopePlan.cells, parent.owned)
	supply(scopePlan, store, bindings, needs.required)
	let disposal: Promise<void> | null = null
	let cancelled = false
	const opened: OpenedStore = {
		chain: [...chain, store],
		cancel: () => {
			// Once is enough: what opens beneath it later is cancelled when disposal reaches it.
			if (cancelled) return
			cancelled = true
			onCancel?.()
			cancelStore(store)
		},
		dispose: () => {
			disposal ??= (async () => {
				try {
					opened.cancel()
					await beforeDisposal?.()
					await disposeStore(store, 'the opened container')
				} finally {
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
				await initialize(needs.order, opened.chain)
			} catch (error) {
				if (!cancelled) throw error
				// Disposal stopped it: it reports that, with what failed for another reason than the abort.
				throw withCleanupFailures(
					cancellation(`Scope '${scopePlan.scope.name}' was disposed while it opened.`),
					errorsOf(error).filter((failure) => !isCancellation(failure) && !isAbort(failure)),
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
	// Dependencies at the same scope may still be initializing (async) and are joined; any
	// other value, a bound promise included, reaches the factory as it is.
	const values = new Array<unknown>(plan.deps.length)
	const waiting: Promise<void>[] = []
	for (let i = 0; i < plan.deps.length; i++) {
		const dep = plan.deps[i]!.plan
		if (!isCached(dep) || dep.scope !== plan.scope) {
			values[i] = resolve(dep, chain)
			continue
		}
		const value = init(dep, chain)
		if (isPromiseLike(value)) {
			waiting.push(
				Promise.resolve(value).then((ready) => {
					values[i] = ready
				}),
			)
		} else {
			values[i] = value
		}
	}

	const create = (): unknown => {
		// Its dependencies may have settled after a sibling's failure cancelled the store.
		if (store.cancelled) {
			abandon(store, record)
			throw cancellation(
				`Service '${plan.name}' was not created: its scope stopped starting services after a failure or disposal.`,
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
	let base: Chain = chain.slice(0, baseLength)
	if (base.length < baseLength) notVisible(plan.name, plan.scope)
	// Remembered, so a long-lived runner follows each hot replacement once.
	let current = plan
	return async (...args) => {
		;[current, base] = hooks.follow(current, base)
		return run(current, base, args)
	}
}

/** Runs once under `base`: opens the run's container, hands the entry to the body, and disposes the container. */
async function run(plan: ExecutionPlan, base: Chain, args: readonly unknown[]): Promise<unknown> {
	const { name } = plan
	const [values, body] = plan.inputs.length === 0 ? [{}, args[0]] : [args[0], args[1]]
	if (typeof body !== 'function' || typeof values !== 'object' || values === null) {
		throw new DowelError(
			'INVALID_NODE',
			plan.inputs.length === 0
				? `Execution '${name}' must be called with a body function.`
				: `Execution '${name}' must be called with an object of its inputs followed by a body function.`,
		)
	}
	const bindings = inputBindings(plan, values)
	// What the entry reaches above the run's scope that nothing provided created, shallowest scope first.
	for (const { depth, order } of plan.lazy) await createShared(order, base.slice(0, depth + 1))
	const controller = new AbortController()
	// The parent owns the run, not just its container: disposing the parent aborts the run's
	// signal and waits for the body before the run's container, and then the parent, are disposed.
	// The body counts as running from just before it is called, so one that starts disposing its
	// owner synchronously is still waited for. Once it settled, disposing the run's container is
	// the run finishing, not a cancellation.
	let phase: 'opening' | Promise<void> | 'settled' = 'opening'
	const notStarted = (): DowelError =>
		cancellation(`Execution '${name}' was disposed before its body started.`)
	const opened = await openStore(
		base,
		plan.child,
		bindings,
		plan.needs,
		() => {
			if (phase !== 'settled')
				controller.abort(cancellation(`Execution '${name}' is being disposed.`))
		},
		async () => {
			if (typeof phase === 'object') await phase
		},
	).catch((error: unknown) => {
		// Disposal stopped the opening: the run reports that, with what else failed.
		const [first, ...others] = errorsOf(error)
		if (!isCancellation(first)) throw error
		throw withCleanupFailures(notStarted(), others, `Execution '${name}'`)
	})
	// Disposal of the run or an owner started before the body could: the body never starts.
	if (controller.signal.aborted) {
		throw withCleanupFailures(
			notStarted(),
			await failuresOf(() => opened.dispose()),
			`Execution '${name}'`,
		)
	}
	const value = await withCleanup(
		async () => {
			let settle = noop
			phase = new Promise<void>((resolve) => {
				settle = resolve
			})
			try {
				return await body(resolve(plan.entry, opened.chain), { signal: controller.signal })
			} finally {
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

const noop = (): void => {}
