import type { RunContext, RunOptions } from '../api.ts'
import { DowelError } from '../errors.ts'
import type { DeclaredScope, Named } from '../model/checks.ts'
import type {
	AnyScope,
	AnyService,
	AnySlot,
	Execution,
	Slot,
	SlotMeta,
} from '../model/declarations.ts'
import type { EntryNotVisible } from '../model/diagnostics.ts'
import type { DependencyGraph, GraphOf, Infer, MetaOf, NameOf } from '../model/infer.ts'
import type { UnionToIntersection } from '../model/util.ts'
import { declaredNode, scopeNode, slotNode } from '../nodes/coerce.ts'
import { isAtOrAbove, sameLineage, scopeNames } from '../nodes/lineage.ts'
import {
	allocateId,
	type ExecutionInput,
	type ExecutionNode,
	internal,
	type SlotNode,
} from '../nodes/node.ts'

/** Single-valued slots in the execution's scope, by the key each run passes its value under. */
type InputSlots<Sc extends AnyScope> = {
	readonly [key: string]: Slot<
		any,
		SlotMeta & { readonly scope: MetaOf<Sc>['name']; readonly many: false }
	>
}

/** The values a run passes for its inputs, by key. */
export type InputValues<Inputs> = { readonly [K in keyof Inputs]: Infer<Inputs[K]> }

type Body<E, R> = (entry: E, run: RunContext) => R | PromiseLike<R>

/**
 * What a dependent receives for an execution: a function that opens a
 * container for the execution's scope with the given input values, hands the
 * entry to `body`, and disposes the container once `body` settles. Without
 * inputs it takes only the body. A `signal` in the options cancels the run.
 */
export type Runner<E, Inputs> = [keyof Inputs] extends [never]
	? <R>(body: Body<E, R>, options?: RunOptions) => Promise<R>
	: <R>(inputs: InputValues<Inputs>, body: Body<E, R>, options?: RunOptions) => Promise<R>

/** `unknown` when the entry lives in the execution's scope or above, where its runs can see it. */
type EntryCheck<Sc extends AnyScope, E> =
	MetaOf<E> extends {
		readonly name: infer Name extends string
		readonly scope: infer Lives extends string
	}
		? Lives extends MetaOf<Sc>['name'] | MetaOf<Sc>['above']
			? unknown
			: EntryNotVisible<Name, Lives>
		: unknown

export interface ExecutionOptions<
	Sc extends AnyScope,
	E extends AnyService | AnySlot,
	I extends InputSlots<Sc>,
> {
	/** The scope each run opens a container for. The runner itself lives in that scope's parent. */
	readonly scope: Sc & DeclaredScope<Sc>
	/** The node handed to the body; it must live in the scope or above. */
	readonly entry: E & EntryCheck<Sc, E>
	/** Scoped slots each run supplies, by the key the runner takes each value by. */
	readonly inputs?: I
}

export type ComputeExecutionMeta<
	N extends string,
	Sc extends AnyScope,
	E extends AnyService | AnySlot,
	I extends { readonly [key: string]: AnySlot },
> = {
	readonly name: N
	readonly scope: MetaOf<Sc>['parent']
	readonly above: Exclude<MetaOf<Sc>['above'], MetaOf<Sc>['parent']>
	readonly child: MetaOf<Sc>['name']
	readonly inputs: NameOf<I[keyof I]>
	// Keep shared entry graphs intact, as service metadata does. Inputs can
	// include slots the entry does not use, so they contribute their own graph.
	readonly graph: UnionToIntersection<GraphOf<E>> &
		DependencyGraph<I> & {
			readonly [K in N]: {
				readonly kind: 'execution'
				readonly scope: MetaOf<Sc>['parent']
				readonly above: Exclude<MetaOf<Sc>['above'], MetaOf<Sc>['parent']>
				readonly deps: NameOf<E>
				readonly optional: never
				readonly child: MetaOf<Sc>['name']
				readonly inputs: NameOf<I[keyof I]>
			}
		}
}

/**
 * Declare work in a child scope a service can launch without holding the
 * container. The runner a dependent receives opens a container for the scope,
 * supplies the inputs, hands the entry to a body and disposes the container
 * when the body settles. Outstanding runs are disposed with their parent.
 *
 * ```ts
 * const Job = execution('Job', { scope: JobScope, entry: JobRunner, inputs: { input: JobInput } })
 * const Scheduler = service('Scheduler', { job: Job }, ({ job }) => ({
 *   schedule: (input) => job({ input }, (runner) => runner.start()),
 * }))
 * ```
 */
export function execution<
	N extends string,
	Sc extends AnyScope,
	E extends AnyService | AnySlot,
	const I extends InputSlots<Sc> = {},
>(
	name: N,
	options: ExecutionOptions<Sc, E, I>,
): Named<N, Execution<Runner<Infer<E>, I>, ComputeExecutionMeta<N, Sc, E, I>>> {
	const scope = scopeNode(options.scope)
	if (scope.parent === null) {
		throw new DowelError(
			'INVALID_SCOPE',
			`Execution '${name}' cannot run in the root scope. Give it a scope of its own.`,
		)
	}
	const entry = declaredNode(options.entry, `the entry of execution '${name}'`)
	if (entry.kind === 'execution') {
		throw new DowelError(
			'INVALID_NODE',
			`Execution '${name}' cannot use another execution as its entry. Use a service that depends on it.`,
		)
	}
	if (!isAtOrAbove(entry.scope, scope)) {
		const [runs, lives] = scopeNames(scope, entry.scope)
		throw new DowelError(
			'CAPTIVE_DEPENDENCY',
			`Execution '${name}' runs in scope '${runs}' but its entry '${entry.name}' lives in '${lives}', which is not visible from there.`,
		)
	}
	const seen = new Map<SlotNode, string>()
	const inputs = Object.entries(options.inputs ?? {}).map(([key, input]): ExecutionInput => {
		const slot = slotNode(input)
		const earlier = seen.get(slot)
		if (earlier !== undefined) {
			throw new DowelError(
				'DUPLICATE',
				`Execution '${name}' lists '${slot.name}' as both input '${earlier}' and input '${key}'.`,
			)
		}
		seen.set(slot, key)
		if (slot.many) {
			throw new DowelError(
				'INVALID_NODE',
				`Execution '${name}' lists multi-binding '${slot.name}' as an input. Inputs are scoped slots each run supplies a value for.`,
			)
		}
		if (!sameLineage(slot.scope, scope)) {
			const [lives, runs] = scopeNames(slot.scope, scope)
			throw new DowelError(
				'INVALID_SCOPE',
				`Execution '${name}' lists '${slot.name}' as an input, but it lives in scope '${lives}', not '${runs}'.`,
			)
		}
		return { key, slot }
	})
	const node: ExecutionNode = { kind: 'execution', id: allocateId(), name, scope, entry, inputs }
	return Object.freeze({
		'~kind': 'execution',
		name,
		scope: scope.parent.name,
		[internal]: node,
	}) as unknown as Named<N, Execution<Runner<Infer<E>, I>, ComputeExecutionMeta<N, Sc, E, I>>>
}
