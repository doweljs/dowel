/** Running an execution: a container for its scope, the entry handed to a body, and the container disposed after. */

import type { RunContext } from '../../api.ts'
import type { ExecutionPlan } from '../../compile/plan.ts'
import { DowelError, failuresOf, withCleanup, withCleanupFailures } from '../../errors.ts'
import type { BindingNode } from '../../nodes/node.ts'
import { resolve } from '../resolve.ts'
import { openStore } from '../scopes/open.ts'
import { onCancel } from '../store/cancel.ts'
import { cancellation, cancelledBy, rewordCancellation } from '../store/dispose.ts'
import { type Chain, noop, notVisible, type Store } from '../store/store.ts'

/** The function a dependent receives for an execution, bound to the stores down to the execution's scope. */
export function runner(
	plan: ExecutionPlan,
	chain: Chain,
): (...args: unknown[]) => Promise<unknown> {
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
	// The parent owns the run: its disposal waits for the body, which counts as running from just
	// before it is called.
	let phase: 'opening' | Promise<void> | 'settled' = 'opening'
	// Why the body never started, worded for this run.
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
 * What a run's body receives besides the entry. Its signal, created only if
 * read, follows the run's cancellation until the body settles, then lets go of
 * the run.
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

/** The `signal` a run was called with, checked by shape so another realm's or a polyfill's works. */
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
