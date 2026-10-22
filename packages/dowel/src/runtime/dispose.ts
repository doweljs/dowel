/** Disposal of instances and stores, shared by the runtime and hot replacement. */

import { DowelError, errorsOf } from '../errors.ts'
import { cancelStore } from './cancel.ts'
import { clearStore, type InstanceRecord, type Store } from './store.ts'

/**
 * Runs the records' disposers last-in-first-out, collecting failures. Each
 * resource is released from the ownership set once its disposer ran, so a
 * later instance may adopt it again.
 */
export async function disposeRecords(
	records: readonly InstanceRecord[],
	what: string,
): Promise<void> {
	const failures: unknown[] = []
	for (let i = records.length - 1; i >= 0; i--) {
		const record = records[i]!
		markDisposed(record)
		const { cleanups, owned } = record
		for (let j = cleanups.length - 1; j >= 0; j--) {
			const { dispose, resource } = cleanups[j]!
			try {
				await dispose()
			} catch (error) {
				failures.push(error)
			} finally {
				if (resource !== null) owned.delete(resource)
			}
		}
		cleanups.length = 0
	}
	if (failures.length > 0) {
		throw new AggregateError(
			failures,
			`${failures.length} disposer(s) failed while disposing ${what}.`,
		)
	}
}

/**
 * Disposes a store: first what it owns (opened containers and runs, newest first,
 * one after another), then the initializations still in flight, then its
 * own instances. The store is marked disposed before anything runs, so
 * nothing new can be resolved from it meanwhile and instances that finish
 * initializing dispose themselves (and are waited for). Every run and
 * starting factory beneath it is aborted before any is waited for, so work
 * that waits on other work all hears of the disposal. It is cleared whatever
 * happens; every failure is collected and thrown together.
 */
export async function disposeStore(store: Store, what: string): Promise<void> {
	store.disposed = true
	// Tell factories and runs still going beneath it to give up; disposal waits for them below.
	cancelStore(store, () => cancellation(`Scope '${store.scope.name}' is being disposed.`))
	const failures: unknown[] = []
	try {
		await disposeChildren(store)
	} catch (error) {
		failures.push(...errorsOf(error))
	}
	if (store.pending !== null) await Promise.allSettled(store.pending)
	try {
		await disposeRecords(store.records, what)
	} catch (error) {
		failures.push(...errorsOf(error))
	} finally {
		clearStore(store)
	}
	if (failures.length > 0) {
		throw new AggregateError(failures, `${failures.length} failure(s) while disposing ${what}.`)
	}
}

/** Marks an instance disposed and aborts its signal. */
export function markDisposed(record: InstanceRecord): void {
	record.disposed = true
	abortSignal(record)
}

/** The signal behind `ctx.signal`, created on first use, and aborted already if disposal or cancellation has started. */
export function signalOf(record: InstanceRecord, store: Store): AbortSignal {
	if (record.controller === null) {
		record.controller = new AbortController()
		// Created late: what it reports may have happened already.
		if (record.disposed) abortSignal(record)
		else if (store.cancelled && store.starting.has(record)) record.controller.abort(store.why!())
	}
	return record.controller.signal
}

function abortSignal(record: InstanceRecord): void {
	record.controller?.abort(cancellation(`Service '${record.plan.name}' is being disposed.`))
}

/** What a cancellation reports: a disposal, or a failure while the store it names initialized. */
export type Cancelled =
	| { readonly kind: 'disposal' }
	| { readonly kind: 'failure'; readonly store: Store }

const disposal: Cancelled = { kind: 'disposal' }
const cancellations = new WeakMap<object, Cancelled>()

/**
 * An error that only reports a cancellation, such as the reason a signal
 * aborts with. Reported after the failure or disposal that caused it, it
 * adds nothing.
 */
export function cancellation(
	message: string,
	cancelled: Cancelled = disposal,
	options?: ErrorOptions,
): DowelError {
	const error = new DowelError('DISPOSED', message, options)
	cancellations.set(error, cancelled)
	return error
}

/** What a cancellation reports, or `undefined` for any other error. */
export function cancelledBy(error: unknown): Cancelled | undefined {
	return typeof error === 'object' && error !== null ? cancellations.get(error) : undefined
}

export function isCancellation(error: unknown): boolean {
	return cancelledBy(error) !== undefined
}

/** Disposes what a store owns, newest first, one after another, collecting failures. */
async function disposeChildren(store: Store): Promise<void> {
	const failures: unknown[] = []
	for (const child of [...store.children].reverse()) {
		try {
			await child.dispose()
		} catch (error) {
			failures.push(...errorsOf(error))
		}
	}
	store.children.clear()
	if (failures.length > 0) {
		throw new AggregateError(
			failures,
			`${failures.length} opened container(s) or run(s) failed to dispose.`,
		)
	}
}
