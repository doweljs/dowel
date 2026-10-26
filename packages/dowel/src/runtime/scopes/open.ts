/** Opening a store for a scope under its parent, for `open()` and for each run. */

import type { ScopeNeeds, ScopePlan } from '../../compile/plan.ts'
import { DowelError, errorsOf, withCleanup, withCleanupFailures } from '../../errors.ts'
import type { BindingNode } from '../../nodes/node.ts'
import { initialize } from '../instances/create.ts'
import { cancelStore } from '../store/cancel.ts'
import { cancellation, cancelledBy, disposeStore, isCancellation } from '../store/dispose.ts'
import { type Chain, type Child, childStore, type Store } from '../store/store.ts'
import { supply } from './supply.ts'

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
 * Opens a store under the last of `chain`: supplies the bindings, registers it
 * with its parent and initializes `needs`. On failure or cancellation it is
 * disposed before the promise rejects.
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

/** Whether an error is how work reports being aborted, as `fetch` and `AbortSignal` do. */
function isAbort(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { name?: unknown }).name === 'AbortError'
	)
}
