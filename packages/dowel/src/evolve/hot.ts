/** Reloading by evolution, and what devtools see of the applications it keeps. */

import type { Container, ContainerBuilder, NodeInfo } from '../api.ts'
import { combine, DowelError } from '../errors.ts'
import type { ContainerState } from '../model/state.ts'
import { noop } from '../runtime/store.ts'
import {
	type AnyBuilder,
	type Buildable,
	buildFirst,
	prepareCandidate,
	type StateOf,
} from './prepare.ts'
import { attach, latestOf } from './protocol.ts'
import type { GenerationInfo } from './succession.ts'

export interface HotOptions {
	/** Keeps the containers of several applications apart in one store. Default: `'default'`. */
	readonly name?: string
	/**
	 * How long, in milliseconds, a superseded generation's runs may take to
	 * finish before they are cancelled. Default: 5000.
	 */
	readonly drain?: number
	/**
	 * How long, in milliseconds, each effect may take to stop or start before
	 * the evaluation fails, so that one that never settles cannot hold up
	 * every evaluation after it. Default: 10000.
	 */
	readonly timeout?: number
}

/**
 * Build `next` the first time a module is evaluated, and on every later
 * evaluation have it succeed the container built before. `store` is an
 * object that outlives evaluations: `import.meta.hot?.data` under Vite,
 * `globalThis` under `bun --hot`. Without one, as in production builds where
 * `import.meta.hot` is undefined, this is `next.build()`.
 *
 * If the successor fails to build or activate, the previous container keeps
 * running and this rejects, after telling {@link onHotFailure} listeners. The
 * evaluation that called it fails with it, and the next one tries again.
 *
 * ```ts
 * export const app = await hot(import.meta.hot?.data, container().provide(Server))
 * if (import.meta.hot) import.meta.hot.accept()
 * ```
 */
export function hot<B extends AnyBuilder>(
	store: object | null | undefined,
	next: Buildable<B>,
	options?: HotOptions,
): Promise<Container<StateOf<B>>>
export async function hot(
	store: object | null | undefined,
	next: ContainerBuilder<ContainerState>,
	options: HotOptions = {},
): Promise<Container> {
	const build = next.build as unknown as () => Promise<Container>
	if (store == null) return build()
	const name = options.name ?? 'default'
	const slots = store as Record<symbol, Lineage | undefined>
	const key = Symbol.for(`dowel.hot:${name}`)
	slots[key] ??= register(null)
	const lineage = slots[key]
	// One evaluation at a time: one that starts while another still hands over waits for it.
	const evolving = lineage.queue.then(() => evolve(lineage, next, options))
	lineage.queue = evolving.then(noop, noop)
	try {
		const container = await evolving
		lineage.failure = null
		return container
	} catch (error) {
		const failure: HotFailure = { name, store, message: messagesOf(error).join('\n'), error }
		lineage.failure = failure.message
		for (const listener of registry().listeners) {
			// A listener that fails must not hide the failure it was told of.
			try {
				listener(failure)
			} catch (listenerError) {
				console.error('[dowel] An onHotFailure() listener failed.', listenerError)
			}
		}
		throw error
	}
}

/** Builds the lineage's first container, or one after its last was disposed; otherwise a successor. */
async function evolve(lineage: Lineage, next: unknown, options: HotOptions): Promise<Container> {
	const timeout = options.timeout ?? 10_000
	const latest = lineage.container === null ? null : latestOf(lineage.container)
	if (latest === null || latest.disposed) {
		const container = await buildFirst(next, timeout)
		// So that a later copy of dowel, as under `bun --hot`, can succeed it.
		attach(container)
		lineage.container = container
		return container
	}
	const prepared = await prepareCandidate(lineage.container, next)
	const activation = await prepared.activate({ drain: options.drain ?? 5000, timeout })
	activation.retired.catch((error: unknown) => {
		console.error('[dowel] Disposing a superseded generation failed.', error)
	})
	lineage.container = activation.container
	return activation.container
}

/**
 * Dispose every container `hot()` keeps in `store`, once evolutions in
 * progress have settled, and forget them: the next `hot()` with that store
 * builds afresh. For dev servers that drop a module or reload it from
 * scratch, losing what it stored.
 */
export async function release(store: object | null | undefined): Promise<void> {
	if (store == null) return
	const slots = store as Record<symbol, Lineage | undefined>
	const disposals: Promise<void>[] = []
	for (const key of Object.getOwnPropertySymbols(store)) {
		const lineage = key.description?.startsWith('dowel.hot:') ? slots[key] : undefined
		if (lineage === undefined) continue
		delete slots[key]
		disposals.push(lineage.queue.then(() => (lineage.container as Container | null)?.dispose()))
	}
	const failures = (await Promise.allSettled(disposals)).flatMap((outcome) =>
		outcome.status === 'rejected' ? [outcome.reason] : [],
	)
	if (failures.length > 0) {
		throw combine(failures, `${failures.length} container(s) failed to dispose.`)
	}
}

/** A failed `hot()`, as {@link onHotFailure} listeners receive it. */
export interface HotFailure {
	/** The lineage's name, as passed to `hot()`. */
	readonly name: string
	/** The store passed to `hot()`, which tells apart the modules that keep containers. */
	readonly store: object
	/** The failure and what caused it, one per line, indented by depth. */
	readonly message: string
	readonly error: unknown
}

/**
 * Be told whenever `hot()` fails in this realm, from any copy of dowel; for
 * dev servers that show failures elsewhere than where they happen. Returns
 * what stops it.
 */
export function onHotFailure(listener: (failure: HotFailure) => void): () => void {
	const { listeners } = registry()
	listeners.add(listener)
	return () => void listeners.delete(listener)
}

/**
 * One application `hot()` keeps evolving: its latest container, why the last
 * attempt failed, and the evolution in progress, which the next one waits
 * for. Plain data, as copies of dowel share it.
 */
interface Lineage {
	readonly id: number
	/** `null` until its first container is built. */
	container: object | null
	failure: string | null
	queue: Promise<void>
}

/** What devtools show of a lineage `hot()` keeps. */
export interface LineageSnapshot {
	/** Stable for as long as the lineage lives. */
	readonly id: number
	/** The active generation's number. */
	readonly generation: number
	/** Why the last attempt to evolve failed, while the previous generation keeps running; `null` after a success. */
	readonly failure: string | null
	readonly nodes: readonly NodeInfo[]
	/** Superseded generations still draining. */
	readonly retiring: readonly GenerationInfo[]
}

/**
 * Lineages `hot()` started, kept globally: under `bun --hot`, dowel itself
 * is evaluated again, and the devtools must still find what earlier copies
 * started.
 */
interface Registry {
	nextId: number
	readonly lineages: Set<WeakRef<Lineage>>
	/** Lineages `track()` registered, kept for as long as their first container is. */
	readonly tracked: WeakMap<object, Lineage>
	readonly listeners: Set<(failure: HotFailure) => void>
}

const REGISTRY = Symbol.for('dowel.hot.lineages')

function registry(): Registry {
	const global = globalThis as { [REGISTRY]?: Registry }
	global[REGISTRY] ??= {
		nextId: 1,
		lineages: new Set(),
		tracked: new WeakMap(),
		listeners: new Set(),
	}
	return global[REGISTRY]
}

function register(container: object | null): Lineage {
	const tracked = registry()
	const lineage: Lineage = {
		id: tracked.nextId++,
		container,
		failure: null,
		queue: Promise.resolve(),
	}
	tracked.lineages.add(new WeakRef(lineage))
	return lineage
}

/**
 * Show a container in devtools, as `hot()` does for the containers it keeps.
 * Devtools see no others, so applications that use neither pay nothing for
 * them. It stays listed while it, or a successor, is running.
 */
export function track(container: Container<any>): void {
	const { tracked } = registry()
	if (!tracked.has(container)) tracked.set(container, register(container))
}

/** Every live lineage `hot()` keeps, or `track()` registered, in this realm, for devtools. */
export function snapshot(): LineageSnapshot[] {
	const { lineages } = registry()
	const snapshots: LineageSnapshot[] = []
	for (const ref of lineages) {
		const lineage = ref.deref()
		// Collected: nothing keeps it any more.
		if (lineage === undefined) {
			lineages.delete(ref)
			continue
		}
		// Not built yet, or disposed: hidden, but kept, since the next evaluation may build into it.
		const evolvable = lineage.container === null ? null : latestOf(lineage.container)
		if (evolvable === null || evolvable.disposed) continue
		const { generation, retiring } = evolvable.describe()
		snapshots.push({
			id: lineage.id,
			generation,
			failure: lineage.failure,
			nodes: (lineage.container as Container).inspect(),
			retiring,
		})
	}
	return snapshots
}

function messagesOf(error: unknown): string[] {
	const own = error instanceof Error ? error.message : String(error)
	if (error instanceof AggregateError) {
		return [own, ...error.errors.flatMap(messagesOf).map((line) => `  ${line}`)]
	}
	if (error instanceof DowelError && error.cause !== undefined) {
		return [own, ...messagesOf(error.cause).map((line) => `  ${line}`)]
	}
	return [own]
}
