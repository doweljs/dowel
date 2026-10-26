/**
 * What a successor needs from the container it succeeds. The successor may
 * come from another copy of dowel: a reload that evaluates every module
 * again, dowel included, builds it with the new copy while the predecessor
 * runs on the old one. So the protocol sits under a global, versioned key,
 * and everything crossing it is plain data, functions and the containers'
 * public API.
 *
 * A container of this copy offers it through its internals. One that only
 * another copy can see offers it once `evolve` attached it, which `hot()`
 * and activation do for the containers they make.
 */

import type { Container } from '../api.ts'
import { internals, RootContainer } from '../runtime/containers.ts'
import {
	describe,
	type GenerationInfo,
	type HandOver,
	handOff,
	type Retirement,
	resume,
	retire,
	supersededReason,
} from './succession.ts'

const EVOLUTION = Symbol.for('dowel.evolution/1')

export interface Evolvable {
	/** The generation's number: 1 for a container `build()` returns, one more per successor. */
	readonly generation: number
	/** Whether a successor may take over: active, not handing over, and not disposed. */
	readonly active: boolean
	readonly disposed: boolean
	/** The container that took over from it, once one has. */
	readonly successor: Container | null
	/** Stops its effects, each within `timeout` milliseconds, and returns what they hand over. */
	handOff(timeout: number): Promise<HandOver>
	/** Starts its effects again, each within `timeout` milliseconds, after the successor failed to. */
	resume(handOvers: ReadonlyMap<string, unknown>, timeout: number): Promise<void>
	/** Forwards from now on to `successor`, and aborts `superseded` for what is pinned to it. */
	supersede(successor: Container): void
	/** Disposes it once the work pinned to it finished, or after `drain` milliseconds at most. */
	retire(drain: number): Retirement
	describe(): GenerationInfo
}

const protocols = new WeakMap<RootContainer, Evolvable>()

/** The protocol a value offers, if it is a root container of this copy of dowel, or one another copy attached it to. */
export function evolvableOf(value: unknown): Evolvable | null {
	if (value instanceof RootContainer) return protocolOf(value)
	if (typeof value !== 'object' || value === null || !(EVOLUTION in value)) return null
	return (value as { readonly [EVOLUTION]: Evolvable })[EVOLUTION]
}

/** Lets later copies of dowel succeed `container`. */
export function attach(container: RootContainer): void {
	if (!Object.hasOwn(container, EVOLUTION)) {
		Object.defineProperty(container, EVOLUTION, { value: protocolOf(container) })
	}
}

/** The protocol of the latest container of `container`'s lineage, if it is one. */
export function latestOf(container: unknown): Evolvable | null {
	let current = evolvableOf(container)
	while (current?.successor != null) current = evolvableOf(current.successor)
	return current
}

function protocolOf(container: RootContainer): Evolvable {
	let protocol = protocols.get(container)
	if (protocol !== undefined) return protocol
	const access = container[internals]
	const { root } = access
	const { generation } = root
	protocol = {
		get generation() {
			return generation.number
		},
		get active() {
			return generation.live && generation.successor === null && !root.disposed
		},
		get disposed() {
			return root.disposed
		},
		get successor() {
			return generation.successor
		},
		handOff: (timeout) => handOff(generation, timeout),
		resume: (handOvers, timeout) => resume(generation, handOvers, timeout),
		supersede: (successor) => generation.supersede(successor, supersededReason(generation)),
		retire: (drain) => retire(access, drain),
		describe: () => describe(access),
	}
	protocols.set(container, protocol)
	return protocol
}
