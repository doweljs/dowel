/**
 * A container's generation: the effects its root-scope services run while
 * it is active, and the few fields `@doweljs/core/evolve` sets when a
 * successor takes over. Without evolution, effects start once the container
 * is built and stop when their instances are disposed; handing them over,
 * resuming them and retiring a generation live in `evolve/`, so only those
 * who import it bundle them.
 */

import type { Container, EffectStart } from '../api.ts'
import { DowelError } from '../errors.ts'
import type { Node } from '../nodes/node.ts'
import { noop } from './store.ts'

/** Stops an effect; what it returns is handed to the successor's effect for the same service. */
type Stop = () => unknown

/** An effect a root-scope service registered with `ctx.whileActive()`. */
export interface Effect {
	/** The service's name, which matches it with its predecessor and successor. */
	readonly name: string
	readonly start: EffectStart
	/** The instance's `ctx.signal`, which its start receives. */
	readonly signal: () => AbortSignal
	stop: Stop | null
	running: boolean
	starting: Promise<void> | null
	/** Its stop function threw, so it may still hold what it started: it is not started again. */
	broken: boolean
	/** What its start in progress was handed, which goes back if that start is given up on. */
	taken: unknown
}

/** A superseded generation still draining, which disposing its successor hurries and waits for. */
export interface Draining {
	hurry(): void
	readonly done: Promise<void>
	describe(): GenerationInfo
}

/** A generation as devtools show it. */
export interface GenerationInfo {
	readonly generation: number
	/** Runs and opened containers still pinned to it at the root. */
	readonly pinned: number
	/** Superseded generations still draining behind it. */
	readonly retiring: readonly GenerationInfo[]
}

/** What waiting for an effect to start may be bounded by: the start itself, by default. */
type Bound = (starting: Promise<void>, effect: Effect) => Promise<void>

const unbounded: Bound = (starting) => starting

export class Generation {
	/** Counts activations along a lineage: 1 for a container `build()` returns, one more per successor. */
	number = 0
	/** Whether an effect starts as soon as its instance exists: not for a candidate, nor while handing over. */
	live = false
	/** The container that took over from this one, which its container forwards to. */
	successor: Container | null = null
	/** Turns a node of an earlier generation into this one's; set for a successor. */
	adopt: ((value: unknown) => Node | null) | null = null
	/** Superseded generations still draining behind this one. */
	readonly behind = new Set<Draining>()
	/** In creation order. */
	readonly effects: Effect[] = []
	/** Handed over by the predecessor and not yet claimed by an effect. */
	handOvers = new Map<string, unknown>()
	private controller: AbortController | null = null
	private reason: unknown = null

	/** Aborted once a successor takes over. */
	get superseded(): AbortSignal {
		if (this.controller === null) {
			this.controller = new AbortController()
			if (this.successor !== null) this.controller.abort(this.reason)
		}
		return this.controller.signal
	}

	supersede(successor: Container, reason: unknown): void {
		this.successor = successor
		this.reason = reason
		this.controller?.abort(reason)
	}

	add(name: string, start: EffectStart, signal: () => AbortSignal): Effect {
		const effect: Effect = {
			name,
			start,
			signal,
			stop: null,
			running: false,
			starting: null,
			broken: false,
			taken: undefined,
		}
		this.effects.push(effect)
		return effect
	}

	/** Starts every effect, in creation order, waiting for each as `bound` allows. */
	async startAll(bound: Bound = unbounded): Promise<void> {
		// Indexed: an effect may cause instances with effects of their own to be created.
		for (let i = 0; i < this.effects.length; i++) {
			const effect = this.effects[i]!
			await bound(this.start(effect), effect)
		}
	}

	/** Starts an effect unless it runs or is starting already. */
	start(effect: Effect): Promise<void> {
		if (effect.running) return Promise.resolve()
		if (effect.broken) {
			return Promise.reject(
				new DowelError(
					'ACTIVATION_FAILED',
					`Service '${effect.name}' is not started again: its effect failed to stop, so it may still hold what it started.`,
				),
			)
		}
		if (effect.starting === null) {
			const starting = this.run(effect).finally(() => {
				if (effect.starting === starting) effect.starting = null
			})
			effect.starting = starting
		}
		return effect.starting
	}

	/** Stops an effect and returns what it hands over, once any start in progress has settled. */
	async stop(effect: Effect): Promise<unknown> {
		await effect.starting?.catch(noop)
		if (!effect.running) return undefined
		const { stop } = effect
		effect.running = false
		effect.stop = null
		try {
			return await stop?.()
		} catch (error) {
			effect.broken = true
			throw error
		}
	}

	/** Stops an effect for good, its instance being disposed. What it hands over is dropped. */
	async drop(effect: Effect): Promise<void> {
		const index = this.effects.indexOf(effect)
		if (index !== -1) this.effects.splice(index, 1)
		await this.stop(effect)
	}

	private async run(effect: Effect): Promise<void> {
		const previous = this.handOvers.get(effect.name)
		this.handOvers.delete(effect.name)
		effect.taken = previous
		try {
			const stop = await effect.start(previous, {
				generation: this.number,
				signal: effect.signal(),
			})
			effect.stop = typeof stop === 'function' ? stop : null
			effect.running = true
		} catch (error) {
			// Not lost: a later start, or the generation it goes back to, receives it.
			if (previous !== undefined) this.handOvers.set(effect.name, previous)
			throw error
		} finally {
			effect.taken = undefined
		}
	}

	/** Gives back what a start in progress was handed, once it is given up on. */
	reclaim(effect: Effect): void {
		if (effect.taken !== undefined) this.handOvers.set(effect.name, effect.taken)
	}
}
