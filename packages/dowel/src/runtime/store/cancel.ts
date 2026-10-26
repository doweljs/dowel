/**
 * Cancelling a store and everything opened beneath it: its starting factories,
 * what it waits for in stores above, the runs it owns, and so on down. The
 * state lives on the stores, and the walk follows the children each store
 * already keeps for disposal, so a run costs nothing extra; a store opened
 * under a cancelled one is born cancelled. It is the subset of
 * `AbortController` the runtime needs: what users see stays a real
 * `AbortSignal`, created from it only when read.
 */

import { noop, type Store } from './store.ts'

/**
 * Cancels a store and what is opened beneath it, once, synchronously.
 * `why` makes the reason when something first reads it, once for everything
 * this cancellation reaches. Listeners must not throw.
 */
export function cancelStore(store: Store, why: () => unknown): void {
	if (store.cancelled) return
	let made = false
	let reason: unknown
	reach(store, () => {
		if (!made) {
			made = true
			reason = why()
		}
		return reason
	})
}

function reach(store: Store, why: () => unknown): void {
	if (store.cancelled) return
	store.cancelled = true
	store.why = why
	// A signal not yet read is created aborted, so a factory that reads `ctx.signal` later sees it aborted.
	for (const record of store.starting) {
		record.controller ??= new AbortController()
		record.controller.abort(why())
	}
	const listeners = store.cancelListeners
	store.cancelListeners = null
	if (listeners !== null) for (const listener of listeners) listener(why)
	for (const child of store.children) reach(child.store, why)
}

/** Calls `listener` once the store is cancelled, at once if it already is; returns what removes it. */
export function onCancel(store: Store, listener: (why: () => unknown) => void): () => void {
	if (store.cancelled) {
		listener(store.why!)
		return noop
	}
	// An array, not a set: a store has few listeners at a time, and most runs add one or none.
	store.cancelListeners ??= []
	const listeners = store.cancelListeners
	listeners.push(listener)
	return () => {
		// Once cancelled, the listeners are being or have been called; removing one would skip another.
		if (store.cancelListeners !== listeners) return
		const index = listeners.indexOf(listener)
		if (index !== -1) listeners.splice(index, 1)
	}
}
