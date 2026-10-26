/**
 * Evolving a running application: a successor container takes over from
 * the one running, without stopping the work in flight.
 *
 * - `prepare(previous, next)` builds `next` as a candidate. Its services exist
 *   and can be tried, but none of its effects (`ctx.whileActive()`) has
 *   started, and `previous` keeps running.
 * - `activate()` makes the candidate the active generation: `previous` stops
 *   its effects and hands what they return to the candidate's, matched by
 *   service name; then `previous` forwards everything it is asked to the
 *   candidate. Runs and containers opened from `previous` before finish on
 *   it, and once they have, it is disposed.
 * - `hot(store, next)` does both on every evaluation of a module, keeping the
 *   container in `store` (`import.meta.hot.data` under Vite, `globalThis`
 *   under `bun --hot`).
 *
 * The predecessor can be a container of another copy of dowel, as when a
 * reload re-evaluates dowel itself; successors then accept its nodes too,
 * by name.
 */

export type { HotFailure, HotOptions, LineageSnapshot } from './evolve/hot.ts'
export { hot, onHotFailure, release, snapshot, track } from './evolve/hot.ts'
export type { ActivateOptions, Activation, Candidate } from './evolve/prepare.ts'
export { prepare } from './evolve/prepare.ts'
export type { GenerationInfo } from './evolve/succession.ts'
