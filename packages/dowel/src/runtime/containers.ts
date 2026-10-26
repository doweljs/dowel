/**
 * Live containers. The one `build()` returns is for scope `root`; each one
 * opened from it is for a child scope, with the chain of stores above it.
 * Containers look nodes up and check visibility; resolving and disposing is
 * done by the plans and stores behind them.
 *
 * A root container is also a generation. Once `@doweljs/core/evolve` lets a
 * successor take over from it, it forwards whatever it is asked to the
 * successor, and disposing it disposes the successor.
 */

import type { Container, NodeInfo } from '../api.ts'
import { type Compiled, emptyScopePlan, isCached, type Plan } from '../compile/plan.ts'
import { DowelError, errorsOf, withCleanup, withCleanupFailures } from '../errors.ts'
import type { ScopeMeta } from '../model/declarations.ts'
import type { ContainerState } from '../model/state.ts'
import { bindingNode, declaredNode, scopeNode } from '../nodes/coerce.ts'
import { sameLineage, scopeNames } from '../nodes/lineage.ts'
import {
	type BindingNode,
	type DeclaredNode,
	internal,
	isCarrier,
	type Node,
	ROOT,
	type ScopeNode,
} from '../nodes/node.ts'
import { cancellation, cancelledBy, disposeStore } from './dispose.ts'
import { Generation } from './generation.ts'
import { inspect } from './inspect.ts'
import { initialize, type OpenedStore, openStore, resolve } from './resolve.ts'
import { type Chain, notVisible, rootStore, type Store } from './store.ts'

/**
 * The plan for a node. A successor's generation adopts the nodes of earlier
 * generations that the graph does not hold itself.
 */
function lookup(compiled: Compiled, generation: Generation, value: unknown): Plan {
	// Only declared nodes have plans, so a hit needs no further check.
	const plan = isCarrier(value)
		? compiled.plans.get((value[internal] as DeclaredNode).id)
		: undefined
	if (plan !== undefined) return plan
	const adopted = generation.adopt?.(value)
	const target =
		adopted != null && isDeclared(adopted) ? adopted : declaredNode(value, 'the node to resolve')
	const found = compiled.plans.get(target.id)
	if (found !== undefined) return found
	throw new DowelError(
		'NOT_PROVIDED',
		target.kind === 'slot'
			? `Slot '${target.name}' is not reachable from what the container provides. Bind it and provide something that depends on it, or provide the slot itself.`
			: `${target.kind === 'service' ? 'Service' : 'Execution'} '${target.name}' is not reachable from what the container provides.`,
	)
}

const isDeclared = (node: Node): node is DeclaredNode =>
	node.kind === 'slot' || node.kind === 'service' || node.kind === 'execution'

/** A scope or binding, adopted from an earlier generation if it is not of this copy of dowel. */
function nodeOf<K extends 'scope' | 'binding'>(
	value: unknown,
	kind: K,
	generation: Generation,
): Extract<Node, { kind: K }> {
	const adopted = isCarrier(value) ? null : generation.adopt?.(value)
	if (adopted?.kind === kind) return adopted as Extract<Node, { kind: K }>
	return (kind === 'scope' ? scopeNode(value) : bindingNode(value)) as Extract<Node, { kind: K }>
}

/** The scope and value bindings an `open()` call asked for. */
function parseScopeArgs(
	args: readonly unknown[],
	generation: Generation,
): { scope: ScopeNode; bindings: BindingNode[] } {
	const [scope, ...bindings] = args
	return {
		scope: nodeOf(scope, 'scope', generation),
		bindings: bindings.map((binding) => nodeOf(binding, 'binding', generation)),
	}
}

type Runner = (...args: unknown[]) => Promise<unknown>

/** Behaviour shared by the root container and the containers opened from it. */
abstract class ContainerBase {
	protected constructor(
		protected readonly compiled: Compiled,
		readonly chain: Chain,
	) {}

	protected get store(): Store {
		return this.chain[this.chain.length - 1]!
	}

	get superseded(): AbortSignal {
		return this.store.generation.superseded
	}

	get(node: unknown): any {
		this.assertLive()
		const plan = lookup(this.compiled, this.store.generation, node)
		// Plans and stores share scope nodes, so identity is exact here.
		if (this.chain[plan.scope.depth]?.scope !== plan.scope) {
			notVisible(plan.name, plan.scope, this.store.scope)
		}
		// Values and runners need nothing created, so only services must have been created with the container.
		if (isCached(plan) && !this.compiled.eager.has(plan)) {
			throw new DowelError(
				'CREATED_ON_DEMAND',
				`'${plan.name}' is reached only through an execution, so runs create it when they need it and get() cannot return it. Provide it to create it with the container.`,
			)
		}
		const value = resolve(plan, this.chain)
		return plan.kind === 'execution' ? this.admit(node, value as Runner) : value
	}

	/** The runner `get()` returns for an execution. */
	protected admit(_node: unknown, runner: Runner): Runner {
		return runner
	}

	async open(...args: readonly unknown[]): Promise<any> {
		this.assertLive()
		const { scope, bindings } = parseScopeArgs(args, this.store.generation)
		const current = this.store.scope
		// Compared by lineage: a scope from an earlier generation is another object with the same names.
		if (scope.parent === null || !sameLineage(scope.parent, current)) {
			const [opening, here] = scopeNames(scope, current)
			throw new DowelError(
				'INVALID_SCOPE',
				`Scope '${opening}' is not a child of '${here}', so it cannot be opened here. A container opens only the scopes directly below its own.`,
			)
		}
		const scopePlan = this.compiled.scopes.get(scope.name) ?? emptyScopePlan(scope)
		const opened = await openStore(this.chain, scopePlan, bindings, scopePlan.needs).catch(
			(error: unknown) => {
				// Disposal stopped the opening: reported as such, with what else failed.
				const [first, ...others] = errorsOf(error)
				const by = cancelledBy(first)
				if (by === undefined) throw error
				throw withCleanupFailures(
					cancellation(`Scope '${scope.name}' was disposed while it opened.`, by, { cause: first }),
					others,
					`Opening scope '${scope.name}'`,
				)
			},
		)
		return new ChildContainer(this.compiled, opened)
	}

	inspect(): NodeInfo[] {
		return inspect(this.compiled, this.chain)
	}

	abstract dispose(): Promise<void>

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose()
	}

	protected abstract readonly what: string

	private assertLive(): void {
		if (this.store.disposed) {
			throw new DowelError(
				'DISPOSED',
				`${this.what[0]!.toUpperCase()}${this.what.slice(1)} has been disposed.`,
			)
		}
	}
}

/** Same-copy access to a root container's generation for `evolve/`; kept off the public API. */
export const internals: unique symbol = Symbol('dowel.internals')

export interface Internals {
	readonly compiled: Compiled
	readonly root: Store
	/** Disposes this generation alone, once, after waiting for those draining behind it. */
	dispose(): Promise<void>
}

export class RootContainer extends ContainerBase implements Container {
	protected readonly what = 'the container'
	private readonly generation: Generation
	private disposal: Promise<void> | null = null

	private constructor(compiled: Compiled, root: Store) {
		super(compiled, [root])
		this.generation = root.generation
	}

	/**
	 * Creates the container's root instances. One `build()` returns then starts
	 * its effects as the first generation of its lineage; a candidate leaves
	 * them for its activation.
	 */
	static async create(compiled: Compiled, activate: boolean): Promise<RootContainer> {
		const generation = new Generation()
		const rootPlan = compiled.scopes.get(ROOT.name)!
		const container = new RootContainer(compiled, rootStore(rootPlan.cells, generation))
		await withCleanup(
			async () => {
				await initialize(rootPlan.needs.order, container.chain)
				if (!activate) return
				generation.number = 1
				generation.live = true
				await generation.startAll()
			},
			() => container.dispose(),
		)
		return container
	}

	/** The latest generation's, so keeping the container keeps hearing of each succession. */
	override get superseded(): AbortSignal {
		const successor = this.successor()
		return successor === null ? super.superseded : successor.superseded
	}

	override get(node: unknown): any {
		if (this.generation.successor === null) return super.get(node)
		return this.successor()!.get(node as never)
	}

	/**
	 * A runner taken from the container starts each run on whichever
	 * generation is active by then. The latest's runner is looked up once per
	 * succession, and a failure to reach it rejects like any failed run.
	 */
	protected override admit(node: unknown, runner: Runner): Runner {
		let forwarded: { readonly to: Container; readonly runner: Runner } | null = null
		return (...args) => {
			const successor = this.successor()
			if (successor === null) return runner(...args)
			try {
				if (forwarded?.to !== successor) {
					forwarded = { to: successor, runner: successor.get(node as never) as Runner }
				}
				return forwarded.runner(...args)
			} catch (error) {
				return Promise.reject(error)
			}
		}
	}

	override open(...args: readonly unknown[]): Promise<any> {
		const successor = this.successor()
		return successor === null ? super.open(...args) : successor.open(...(args as [never]))
	}

	override inspect(): NodeInfo[] {
		const successor = this.successor()
		return successor === null ? super.inspect() : [...successor.inspect()]
	}

	/** Disposing any container of a lineage disposes the latest, and the generations still draining behind it. */
	dispose(): Promise<void> {
		const successor = this.successor()
		if (successor !== null) return successor.dispose()
		for (const draining of this.generation.behind) draining.hurry()
		return this.disposeGeneration()
	}

	private disposeGeneration(): Promise<void> {
		this.disposal ??= (async () => {
			try {
				await disposeStore(this.store, this.what)
			} finally {
				const { behind } = this.generation
				await Promise.allSettled([...behind].map((draining) => draining.done))
			}
		})()
		return this.disposal
	}

	/** The latest container of the lineage once a successor took over; `null` until then. */
	private successor(): Container | null {
		let latest = this.generation.successor
		if (latest === null) return null
		// Followed within this copy of dowel, so a container superseded many times over forwards in one step.
		while (latest instanceof RootContainer && latest.generation.successor !== null) {
			latest = latest.generation.successor
		}
		this.generation.successor = latest
		return latest
	}

	get [internals](): Internals {
		return { compiled: this.compiled, root: this.store, dispose: () => this.disposeGeneration() }
	}
}

class ChildContainer extends ContainerBase implements Container<ContainerState, ScopeMeta> {
	protected readonly what = 'the opened container'

	constructor(
		compiled: Compiled,
		private readonly opened: OpenedStore,
	) {
		super(compiled, opened.chain)
	}

	dispose(): Promise<void> {
		return this.opened.dispose()
	}
}
