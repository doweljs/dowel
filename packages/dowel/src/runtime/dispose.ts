/** Disposal of instances and stores, shared by the runtime and hot replacement. */

import { DowelError, errorsOf } from '../errors.ts'
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
 * initializing dispose themselves (and are waited for). Every run beneath it
 * is aborted before any is waited for, so runs that wait on each other all
 * hear of the disposal. It is cleared whatever happens; every failure is
 * collected and thrown together.
 */
export async function disposeStore(store: Store, what: string): Promise<void> {
	store.disposed = true
	// Tell factories still running to give up; disposal waits for them below.
	cancelStarting(store)
	cancelChildren(store)
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

/**
 * Stops a store from starting factories, and aborts the signals of those
 * still running. A signal not yet read is created aborted, so a factory that
 * reads `ctx.signal` later sees it aborted.
 */
export function cancelStarting(store: Store): void {
	store.cancelled = true
	for (const record of store.starting) {
		record.controller ??= new AbortController()
		abortSignal(record)
	}
}

/** The signal behind `ctx.signal`, created on first use, and aborted already if disposal has started. */
export function signalOf(record: InstanceRecord, store: Store): AbortSignal {
	if (record.controller === null) {
		record.controller = new AbortController()
		// Created late: the disposal it reports may have started already.
		if (record.disposed || (store.disposed && store.starting.has(record))) abortSignal(record)
	}
	return record.controller.signal
}

function abortSignal(record: InstanceRecord): void {
	record.controller?.abort(cancellation(`Service '${record.plan.name}' is being disposed.`))
}

const cancellations = new WeakSet<object>()

/**
 * An error that only reports a cancellation, such as the reason a signal
 * aborts with. Reported after the failure or disposal that caused it, it
 * adds nothing.
 */
export function cancellation(message: string): DowelError {
	const error = new DowelError('DISPOSED', message)
	cancellations.add(error)
	return error
}

export function isCancellation(error: unknown): boolean {
	return typeof error === 'object' && error !== null && cancellations.has(error)
}

/** Aborts the signals of every run beneath a store, newest first, as disposal will reach them. */
export function cancelChildren(store: Store): void {
	for (const child of [...store.children].reverse()) child.cancel()
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
