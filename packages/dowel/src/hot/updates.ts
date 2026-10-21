/**
 * What a build tool calls: registering a module's declarations, rebuilding
 * the containers they affect, and reporting each container's state. Updates
 * run one at a time, in the order they arrive.
 */

import type { NodeInfo } from '../api.ts'
import { DowelError } from '../errors.ts'
import { describe, internal, isCarrier } from '../nodes/node.ts'
import { hooks, hotAccess, type TrackedContainer } from '../runtime/hooks.ts'
import { type Declared, registry, usesReplacedNode } from './registry.ts'
import { type Committed, replaceGeneration } from './replace.ts'

export interface HotUpdate {
	/** Names of the nodes the module re-declared. */
	readonly changed: readonly string[]
	/** Containers that were rebuilt. */
	readonly rebuilt: number
}

export interface ContainerStatus {
	/**
	 * `current`: running the latest declarations. `failed`: the last
	 * replacement failed and the previous generation is still running.
	 */
	readonly state: 'current' | 'failed'
	readonly error: string | null
}

export interface ContainerSnapshot {
	/** Stable identity of the container across rebuilds. */
	readonly id: number
	readonly status: ContainerStatus
	readonly nodes: readonly NodeInfo[]
}

const statuses = new WeakMap<TrackedContainer, ContainerStatus>()
const CURRENT: ContainerStatus = { state: 'current', error: null }

let queue: Promise<unknown> = Promise.resolve()

/** Runs `task` once everything queued before it has finished, successfully or not. */
function enqueue<T>(task: () => T | Promise<T>): Promise<T> {
	const result = queue.then(task, task)
	queue = result.catch(() => undefined)
	return result
}

/**
 * Register the declarations a module currently exports. The first call for
 * a module only records them; later calls rebuild live containers. A name
 * declared by two modules is rejected before anything changes, since names
 * identify nodes. Concurrent calls are applied in sequence.
 */
export async function update(
	moduleId: string,
	declarations: Record<string, unknown>,
): Promise<HotUpdate> {
	const { result, failures, teardowns } = await enqueue(() => apply(moduleId, declarations))
	// Later updates start once this one committed; its own promise still waits for its teardown.
	const teardownFailures = (await Promise.allSettled(teardowns)).flatMap((outcome) =>
		outcome.status === 'rejected' ? [outcome.reason] : [],
	)
	const all = [...failures, ...teardownFailures]
	if (all.length > 0) {
		throw combine(
			all,
			`${all.length} failure(s) while replacing containers after ${moduleId} changed.`,
		)
	}
	return result
}

/** Release the names a module declared, for example when the module was deleted or is no longer imported. */
export function forget(moduleId: string): Promise<void> {
	// Queued like updates, so an update queued earlier cannot restore what this releases.
	return enqueue(() => registry.forget(moduleId))
}

/** Describe every live container, for devtools. */
export function snapshot(): ContainerSnapshot[] {
	return [...hooks.containers].map((container) => ({
		id: container[hotAccess].serial,
		status: statuses.get(container) ?? CURRENT,
		nodes: container.inspect(),
	}))
}

/** Forget every registration. Intended for tests. */
export function reset(): void {
	registry.clear()
}

/** Frames a hot-replacement failure for display by a build tool, listing every underlying failure. */
export function describeFailure(error: unknown): string {
	return `[dowel] hot replacement failed.\n${messagesOf(error).join('\n')}`
}

/** An update once committed: the containers that failed to rebuild, and the teardowns of those that did. */
interface Applied {
	readonly result: HotUpdate
	readonly failures: readonly unknown[]
	readonly teardowns: readonly Promise<void>[]
}

async function apply(moduleId: string, declarations: Record<string, unknown>): Promise<Applied> {
	const incoming: Declared[] = []
	for (const value of Object.values(declarations)) {
		if (!isCarrier(value)) continue
		const node = value[internal]
		if (node.kind === 'binding') continue
		const owner = registry.ownerOf(node)
		if (owner !== undefined && owner !== moduleId) {
			throw new DowelError(
				'DUPLICATE',
				`${describe(node)} is declared by both ${owner} and ${moduleId}. Names identify nodes, so rename one of them; after moving a declaration between modules, reload.`,
			)
		}
		incoming.push(node)
	}

	const { changed, changedNodes } = registry.claim(moduleId, incoming)
	const affected = [...hooks.containers].filter((container) =>
		usesReplacedNode(container[hotAccess].compiled, changedNodes),
	)
	for (const container of affected) {
		if (!container[hotAccess].initialized) rebuildWhenReady(container)
	}
	const ready = affected.filter((container) => container[hotAccess].initialized)
	const outcomes = await Promise.allSettled(ready.map(rebuild))
	return {
		result: { changed, rebuilt: ready.length },
		failures: outcomes.flatMap((outcome) =>
			outcome.status === 'rejected' ? [outcome.reason] : [],
		),
		teardowns: outcomes.flatMap((outcome) =>
			outcome.status === 'fulfilled' ? [outcome.value.teardown] : [],
		),
	}
}

/** Replaces a container's generation and records how that went. */
async function rebuild(container: TrackedContainer): Promise<Committed> {
	const access = container[hotAccess]
	if (access.root.disposed) return { teardown: Promise.resolve() }
	let committed: Committed
	try {
		const work = replaceGeneration(access)
		access.track(work)
		committed = await work
	} catch (error) {
		statuses.set(container, {
			state: 'failed',
			error: messagesOf(error).join('\n'),
		})
		throw error
	}
	statuses.set(container, CURRENT)
	// Disposing the container waits for this too.
	access.track(committed.teardown)
	return committed
}

const deferred = new WeakSet<TrackedContainer>()

/**
 * Replacing a container still initializing would duplicate or drop its
 * instances, so it is rebuilt once ready, in the update queue. Its failure
 * shows in {@link snapshot}; other updates do not wait for it.
 */
function rebuildWhenReady(container: TrackedContainer): void {
	if (deferred.has(container)) return
	deferred.add(container)
	void container[hotAccess].ready.then(() => {
		deferred.delete(container)
		// Nobody awaits it: a failed replacement shows in the container's status, and a failed
		// teardown is dropped.
		void enqueue(() => rebuild(container))
			.then(({ teardown }) => teardown)
			.catch(() => undefined)
	})
}

function combine(failures: readonly unknown[], message: string): unknown {
	return failures.length === 1 ? failures[0] : new AggregateError(failures, message)
}

function messagesOf(error: unknown): string[] {
	if (error instanceof AggregateError) {
		return [error.message, ...error.errors.flatMap(messagesOf).map((line) => `  ${line}`)]
	}
	return [error instanceof Error ? error.message : String(error)]
}
