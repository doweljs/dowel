/** Preparing a candidate to succeed a running container, and activating it. */

import type { Container, ContainerBuilder } from '../api.ts'
import { buildCandidate } from '../container.ts'
import { combine, DowelError, failuresOf, withCleanupFailures } from '../errors.ts'
import type { NotBuildable } from '../model/diagnostics.ts'
import type { ContainerState } from '../model/state.ts'
import { internals, type RootContainer } from '../runtime/containers.ts'
import { attach, type Evolvable, latestOf } from './protocol.ts'
import {
	ActivationFailure,
	activate,
	adopter,
	type HandOver,
	handOff,
	within,
} from './succession.ts'

/** A container prepared to succeed another, not yet active. */
export interface Candidate<S extends ContainerState> {
	/**
	 * The candidate itself. Everything `build()` would create exists, but no
	 * effect has started: resolve from it to try it out before activating.
	 */
	readonly container: Container<S>
	/**
	 * Make it the active generation. If an effect fails to start, the ones
	 * that started stop again, the predecessor resumes with what was handed
	 * back, the candidate is discarded, and this rejects with
	 * `ACTIVATION_FAILED`.
	 */
	activate(options?: ActivateOptions): Promise<Activation<S>>
	/** Dispose it without activating it. */
	discard(): Promise<void>
}

export interface ActivateOptions {
	/**
	 * How long, in milliseconds, the predecessor waits for the runs and
	 * containers opened from it to finish before it cancels what is left and
	 * is disposed. Default: no limit.
	 */
	readonly drain?: number
	/**
	 * How long, in milliseconds, each effect may take to stop in the
	 * predecessor, or to start in the candidate, before activation fails with
	 * `ACTIVATION_FAILED`, so that one that never settles cannot hold the
	 * succession up. An effect that overran its stop is never started again.
	 * Default: no limit.
	 */
	readonly timeout?: number
}

export interface Activation<S extends ContainerState> {
	/** The new generation's number: one more than its predecessor's. */
	readonly generation: number
	readonly container: Container<S>
	/**
	 * Settles once the predecessor, and the generations still draining behind
	 * it, are disposed. Rejects only with what failed to dispose: the
	 * activation itself succeeded.
	 */
	readonly retired: Promise<void>
}

export type AnyBuilder = ContainerBuilder<any>

/**
 * The builder itself when `build()` is callable; otherwise what `build()`
 * reports, which is never a function. Builders are taken as an opaque `B`
 * checked this way, rather than as `ContainerBuilder<S> & Check<S>`, whose
 * inference explores an inline builder expression exhaustively.
 */
export type Buildable<B extends AnyBuilder> = B['build'] extends () => unknown
	? B
	: NotBuildable<B['build']>

export type StateOf<B> = B extends ContainerBuilder<infer S> ? S : never

/**
 * Build `next` as a candidate to succeed `previous`, or the latest container
 * to have succeeded it. `previous` keeps running meanwhile; nothing changes
 * for it until the candidate is activated. Rejects as `build()` does if the
 * candidate fails to initialize.
 *
 * Once activated, `previous` resolves what it is asked from the candidate,
 * by name, so a node the candidate no longer provides is `NOT_PROVIDED`.
 */
export function prepare<B extends AnyBuilder>(
	previous: Container<any>,
	next: Buildable<B>,
): Promise<Candidate<StateOf<B>>>
export function prepare(previous: unknown, next: unknown): Promise<Candidate<any>> {
	return prepareCandidate(previous, next)
}

/**
 * Builds `next` as the first generation of a lineage, its effects started
 * within `timeout` each; if one fails, the container is disposed and the
 * build rejects with why.
 */
export async function buildFirst(next: unknown, timeout: number): Promise<RootContainer> {
	const building = buildCandidate(next)
	if (building === null) {
		throw new DowelError('INVALID_NODE', 'Expected a container builder from container().')
	}
	const container = await building
	try {
		await activate(container[internals].root.generation, 1, new Map(), timeout)
	} catch (failure) {
		const { cause, handOver } =
			failure instanceof ActivationFailure ? failure : new ActivationFailure(failure, NOTHING)
		throw withCleanupFailures(cause, [
			...handOver.failures,
			...(await failuresOf(() => disposeWithin(container, timeout))),
		])
	}
	return container
}

const NOTHING: HandOver = { values: new Map(), failures: [] }

export async function prepareCandidate(
	previous: unknown,
	next: unknown,
): Promise<PreparedCandidate> {
	const predecessor = latestOf(previous)
	if (predecessor === null) {
		throw new DowelError(
			'INVALID_NODE',
			'Expected a container from build(), or, from another copy of dowel, one that hot() built or a successor activated.',
		)
	}
	if (!predecessor.active) throw notActive(predecessor)
	const building = buildCandidate(next)
	if (building === null) {
		throw new DowelError('INVALID_NODE', 'Expected a container builder from container().')
	}
	const container = await building
	const { compiled, root } = container[internals]
	root.generation.adopt = adopter(compiled)
	return new PreparedCandidate(predecessor, container)
}

class PreparedCandidate implements Candidate<any> {
	private settled: 'activated' | 'discarded' | null = null

	constructor(
		private readonly predecessor: Evolvable,
		readonly container: RootContainer,
	) {}

	async activate({
		drain = Number.POSITIVE_INFINITY,
		timeout = Number.POSITIVE_INFINITY,
	}: ActivateOptions = {}): Promise<Activation<any>> {
		this.settle('activated')
		const { predecessor, container } = this
		const { root } = container[internals]
		const generation = predecessor.generation + 1
		const discard = () => failuresOf(() => disposeWithin(container, timeout))
		const resume = (values: ReadonlyMap<string, unknown>) =>
			failuresOf(() => predecessor.resume(values, timeout))
		if (root.disposed) throw candidateDisposed()
		if (!predecessor.active) throw withCleanupFailures(notActive(predecessor), await discard())

		const handOver: HandOver = await predecessor.handOff(timeout)
		// Either container may have been disposed meanwhile; nothing has started in the candidate yet.
		if (predecessor.disposed) {
			throw withCleanupFailures(predecessorDisposed(predecessor), await discard())
		}
		if (root.disposed) throw withCleanupFailures(candidateDisposed(), await resume(handOver.values))
		if (handOver.failures.length > 0) {
			throw activationFailed(
				`Generation ${predecessor.generation} failed to stop its effects, so it resumed and generation ${generation} was discarded.`,
				combine(handOver.failures, `${handOver.failures.length} effect(s) failed to stop.`),
				[...(await resume(handOver.values)), ...(await discard())],
			)
		}

		try {
			await activate(root.generation, generation, handOver.values, timeout)
		} catch (failure) {
			const { cause, handOver: back } =
				failure instanceof ActivationFailure ? failure : new ActivationFailure(failure, handOver)
			throw activationFailed(
				`Generation ${generation} failed to start its effects, so generation ${predecessor.generation} resumed.`,
				cause,
				[...back.failures, ...(await resume(back.values)), ...(await discard())],
			)
		}
		// Or while the candidate's effects started.
		if (predecessor.disposed) {
			const back = await handOff(root.generation, timeout)
			throw withCleanupFailures(predecessorDisposed(predecessor), [
				...back.failures,
				...(await discard()),
			])
		}
		// Its effects stopped with its instances, and what they held went with them: the predecessor
		// resumes from what it handed over.
		if (root.disposed) throw withCleanupFailures(candidateDisposed(), await resume(handOver.values))

		predecessor.supersede(container)
		const retirement = predecessor.retire(drain)
		const { behind } = root.generation
		behind.add(retirement)
		const forget = () => void behind.delete(retirement)
		retirement.done.then(forget, forget)
		attach(container)
		return { generation, container, retired: retirement.done }
	}

	discard(): Promise<void> {
		this.settle('discarded')
		return this.container.dispose()
	}

	private settle(as: 'activated' | 'discarded'): void {
		if (this.settled !== null) {
			throw new DowelError('SUPERSEDED', `The candidate was already ${this.settled}.`)
		}
		this.settled = as
	}
}

function notActive(predecessor: Evolvable): DowelError {
	return new DowelError(
		'SUPERSEDED',
		`Generation ${predecessor.generation} is not active, so nothing can succeed it.`,
	)
}

/** Bounded: an effect that ignores its signal can keep a discarded container disposing in the background. */
function disposeWithin(container: RootContainer, timeout: number): Promise<void> {
	return within(
		container.dispose(),
		timeout,
		() =>
			new DowelError(
				'ACTIVATION_FAILED',
				`The discarded container did not finish disposing within ${timeout} ms; it goes on in the background.`,
			),
	)
}

function candidateDisposed(): DowelError {
	return new DowelError('SUPERSEDED', 'The candidate was disposed, so it did not take over.')
}

function predecessorDisposed(predecessor: Evolvable): DowelError {
	return new DowelError(
		'SUPERSEDED',
		`Generation ${predecessor.generation} was disposed while its successor took over, so the successor was discarded too.`,
	)
}

function activationFailed(message: string, cause: unknown, cleanup: readonly unknown[]): unknown {
	return withCleanupFailures(
		new DowelError('ACTIVATION_FAILED', message, { cause }),
		cleanup,
		'Activation',
	)
}
