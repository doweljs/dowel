/**
 * One generation taking over from another: handing effects over, starting
 * them in the successor or back in the predecessor, retiring the
 * predecessor once its work drained, and resolving the nodes earlier code
 * still holds.
 */

import type { Compiled, GraphNode } from '../compile/plan.ts'
import { combine, DowelError } from '../errors.ts'
import { internal, isCarrier, type Node } from '../nodes/node.ts'
import type { Internals } from '../runtime/containers.ts'
import type { Draining, Effect, Generation, GenerationInfo } from '../runtime/generation.ts'
import { noop } from '../runtime/store.ts'

/** What a generation hands its successor: a value per service, and what failed to stop. */
export interface HandOver {
	readonly values: ReadonlyMap<string, unknown>
	readonly failures: readonly unknown[]
}

export type { GenerationInfo } from '../runtime/generation.ts'

/** A superseded generation on its way out. */
export interface Retirement extends Draining {
	/** Settles once it, and the generations still draining behind it, are disposed; rejects with what failed to dispose. */
	readonly done: Promise<void>
	/** Stops waiting for its work, and that of the generations behind it, to finish: what still runs is cancelled and waited for. */
	hurry(): void
}

/** Activation failed: the effects that had started were stopped, and what they handed back. */
export class ActivationFailure {
	constructor(
		readonly cause: unknown,
		readonly handOver: HandOver,
	) {}
}

/**
 * Stops every effect, newest first, so a successor can start from what they
 * return. Each stop function gets `timeout` milliseconds: one that takes
 * longer is reported as a failure and marked broken, since it may still hold
 * what it started, so it is never started again, and what it returns once it
 * does finish is dropped.
 */
export async function handOff(generation: Generation, timeout: number): Promise<HandOver> {
	generation.live = false
	const values = new Map<string, unknown>()
	const failures: unknown[] = []
	const { effects } = generation
	for (let i = effects.length - 1; i >= 0; i--) {
		const effect = effects[i]!
		// Given up on already: its instance's disposal stops it, whenever it settles.
		if (effect.broken && !effect.running) continue
		try {
			const value = await within(generation.stop(effect), timeout, () => {
				effect.broken = true
				return overran(effect, 'stop', timeout)
			})
			if (value !== undefined) values.set(effect.name, value)
		} catch (error) {
			failures.push(error)
		}
	}
	// What nothing claimed passes on, so state survives a generation that never created its service.
	for (const [name, value] of generation.handOvers) if (!values.has(name)) values.set(name, value)
	generation.handOvers = new Map()
	return { values, failures }
}

/**
 * Starts a candidate's effects as generation `number`, from what its
 * predecessor handed over, each within `timeout` milliseconds. On failure
 * the ones that started are stopped again, and what they and the
 * predecessor handed over comes back in the failure.
 */
export async function activate(
	generation: Generation,
	number: number,
	handOvers: ReadonlyMap<string, unknown>,
	timeout: number,
): Promise<void> {
	generation.number = number
	generation.handOvers = new Map(handOvers)
	generation.live = true
	try {
		await generation.startAll((starting, effect) =>
			startWithin(generation, starting, effect, timeout),
		)
	} catch (cause) {
		throw new ActivationFailure(cause, await handOff(generation, timeout))
	}
}

/** Starts the effects again after the successor failed to, from what it handed back. */
export async function resume(
	generation: Generation,
	handOvers: ReadonlyMap<string, unknown>,
	timeout: number,
): Promise<void> {
	generation.handOvers = new Map(handOvers)
	generation.live = true
	const failures: unknown[] = []
	for (const effect of [...generation.effects]) {
		try {
			await startWithin(generation, generation.start(effect), effect, timeout)
		} catch (error) {
			failures.push(error)
		}
	}
	if (failures.length > 0) {
		throw combine(failures, `${failures.length} effect(s) failed to resume.`)
	}
}

/**
 * `work`, or the error `timedOut` makes once `timeout` milliseconds have
 * passed. The work goes on in the background, its outcome ignored.
 */
export function within<T>(work: Promise<T>, timeout: number, timedOut: () => unknown): Promise<T> {
	if (!Number.isFinite(timeout)) return work
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			work.catch(noop)
			reject(timedOut())
		}, timeout)
		// The timer only bounds the work; it must not keep a process alive by itself.
		;(timer as { unref?: () => void }).unref?.()
		work.then(
			(value) => {
				clearTimeout(timer)
				resolve(value)
			},
			(error: unknown) => {
				clearTimeout(timer)
				reject(error)
			},
		)
	})
}

/** Waits for an effect to start within `timeout`, giving back what it was handed if it takes longer. */
function startWithin(
	generation: Generation,
	starting: Promise<void>,
	effect: Effect,
	timeout: number,
): Promise<void> {
	return within(starting, timeout, () => {
		generation.reclaim(effect)
		effect.broken = true
		return overran(effect, 'start', timeout)
	})
}

function overran(effect: Effect, what: 'start' | 'stop', timeout: number): DowelError {
	return new DowelError(
		'ACTIVATION_FAILED',
		`Service '${effect.name}' did not ${what} its effect within ${timeout} ms${what === 'stop' ? ', so it is not started again' : ''}.`,
	)
}

/** Why a superseded generation's `superseded` signal aborts. */
export function supersededReason(generation: Generation): DowelError {
	return new DowelError(
		'SUPERSEDED',
		`Generation ${generation.number} was superseded by generation ${generation.number + 1}.`,
	)
}

/**
 * Waits for what is pinned to a generation at the root (runs and opened
 * containers) to finish, then disposes it. Once `drain` milliseconds have
 * passed, what still runs is cancelled and waited for. Its own deadline
 * leaves the generations behind it to theirs; hurrying it, as disposing the
 * lineage does, hurries them too.
 */
export function retire(container: Internals, drain: number): Retirement {
	const { root } = container
	const { generation } = root
	let release = noop
	const released = new Promise<void>((resolve) => {
		release = resolve
	})
	const drained = new Promise<void>((resolve) => {
		if (root.children.size === 0) resolve()
		else root.drained = resolve
	})
	if (drain <= 0) release()
	const timer = drain > 0 && Number.isFinite(drain) ? setTimeout(release, drain) : undefined
	// The timer only bounds the drain; it must not keep a process alive by itself.
	;(timer as { unref?: () => void } | undefined)?.unref?.()
	const done = Promise.race([drained, released]).then(() => {
		clearTimeout(timer)
		root.drained = null
		return container.dispose()
	})
	// Rejections reach whoever awaits it; nobody has to.
	done.catch(noop)
	return {
		done,
		hurry: () => {
			release()
			for (const draining of generation.behind) draining.hurry()
		},
		describe: () => describe(container),
	}
}

export function describe({ root }: Internals): GenerationInfo {
	return {
		generation: root.generation.number,
		pinned: root.children.size,
		retiring: [...root.generation.behind].map((draining) => draining.describe()),
	}
}

/**
 * Resolves, by name, a node an earlier generation was built from, for a
 * successor built from `compiled`: one a module evaluated again has
 * replaced, or one of another copy of dowel, as under `bun --hot`.
 */
export function adopter(compiled: Compiled): (value: unknown) => Node | null {
	let byName: Map<string, GraphNode> | null = null
	return (value) => {
		const node = nodeBehind(value)
		if (node === null) return null
		switch (node.kind) {
			case 'scope':
				return compiled.scopes.get(node.name)?.scope ?? node
			case 'binding':
				// Supplied by name and compared by lineage, which nodes of any copy carry.
				return node
			default: {
				byName ??= new Map(compiled.graph.map((graphNode) => [graphNode.name, graphNode]))
				const named = byName.get(node.name)
				return named?.kind === node.kind ? ({ ...node, id: named.id } as Node) : null
			}
		}
	}
}

/** The node behind a value, from this copy of dowel or another. */
function nodeBehind(value: unknown): Node | null {
	if (isCarrier(value)) return value[internal]
	if (typeof value !== 'object' || value === null) return null
	for (const symbol of Object.getOwnPropertySymbols(value)) {
		if (symbol.description === 'dowel.internal')
			return (value as Record<symbol, Node>)[symbol] ?? null
	}
	return null
}
