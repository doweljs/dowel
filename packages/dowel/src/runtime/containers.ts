/**
 * Live containers. The one `build()` returns is for scope `root`; each one
 * opened from it is for a child scope, with the chain of stores above it.
 * Containers look nodes up and check visibility; resolving and disposing is done by
 * the plans and stores behind them.
 */

import type { Container, NodeInfo } from '../api.ts'
import type { Composition } from '../compile/compile.ts'
import { type Compiled, emptyScopePlan, isCached, type Plan } from '../compile/plan.ts'
import { DowelError, errorsOf, withCleanup, withCleanupFailures } from '../errors.ts'
import type { ScopeMeta } from '../model/declarations.ts'
import type { ContainerState } from '../model/state.ts'
import { bindingNode, declaredNode, scopeNode } from '../nodes/coerce.ts'
import { sameLineage, scopeNames } from '../nodes/lineage.ts'
import { type BindingNode, ROOT, type ScopeNode } from '../nodes/node.ts'
import { cancellation, cancelledBy, disposeStore } from './dispose.ts'
import { type HotAccess, hooks, hotAccess } from './hooks.ts'
import { inspect } from './inspect.ts'
import { initialize, type OpenedStore, openStore, resolve } from './resolve.ts'
import { type Chain, newStore, noop, notVisible, type Store } from './store.ts'

function lookup(compiled: Compiled, node: unknown): Plan {
	const target = declaredNode(node, 'the node to resolve')
	const plan = compiled.plans.get(target.id)
	if (plan === undefined) {
		throw new DowelError(
			'NOT_PROVIDED',
			target.kind === 'slot'
				? `Slot '${target.name}' is not reachable from what the container provides. Bind it and provide something that depends on it, or provide the slot itself.`
				: `${target.kind === 'service' ? 'Service' : 'Execution'} '${target.name}' is not reachable from what the container provides.`,
		)
	}
	return plan
}

/** The scope and value bindings an `open()` call asked for. */
function parseScopeArgs(args: readonly unknown[]): { scope: ScopeNode; bindings: BindingNode[] } {
	const [scope, ...bindings] = args
	return { scope: scopeNode(scope), bindings: bindings.map(bindingNode) }
}

/** Behaviour shared by the root container and the containers opened from it. */
abstract class ContainerBase {
	protected constructor(
		protected compiled: Compiled,
		public chain: Chain,
	) {}

	protected get store(): Store {
		return this.chain[this.chain.length - 1]!
	}

	get(node: unknown): any {
		this.assertLive()
		const plan = lookup(this.compiled, node)
		// Plans and stores share canonical scope nodes, so identity is exact here.
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
		return resolve(plan, this.chain)
	}

	async open(...args: readonly unknown[]): Promise<any> {
		this.assertLive()
		const { scope, bindings } = parseScopeArgs(args)
		const current = this.store.scope
		// Compared by lineage: a scope re-declared by hot replacement is a new object.
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

let nextSerial = 0

export class RootContainer extends ContainerBase implements Container {
	protected readonly what = 'the container'
	private readonly serial = nextSerial++
	private ready: Promise<void> = Promise.resolve()
	private initialized = false
	/** Hot replacements in progress, which disposal waits for. */
	private readonly work = new Set<Promise<void>>()
	private disposal: Promise<void> | null = null

	private constructor(
		private readonly composition: Composition,
		compiled: Compiled,
		root: Store,
	) {
		super(compiled, [root])
	}

	static async create(composition: Composition, compiled: Compiled): Promise<Container> {
		const rootPlan = compiled.scopes.get(ROOT.name)!
		const root = newStore(ROOT, rootPlan.cells, new WeakSet(), null)
		const container = new RootContainer(composition, compiled, root)
		const init = withCleanup(
			() => initialize(rootPlan.needs.order, [root]),
			() => container.dispose(),
		)
		container.ready = init.then(noop, noop).then(() => {
			container.initialized = true
		})
		if (hooks.enabled) hooks.containers.add(container)
		await init
		return container
	}

	get [hotAccess](): HotAccess {
		return {
			serial: this.serial,
			composition: this.composition,
			compiled: this.compiled,
			root: this.store,
			initialized: this.initialized,
			ready: this.ready,
			swap: (compiled, root) => {
				this.compiled = compiled
				this.chain = [root]
			},
			track: (work) => {
				const settled = work.then(noop, noop)
				this.work.add(settled)
				void settled.then(() => this.work.delete(settled))
			},
		}
	}

	dispose(): Promise<void> {
		this.disposal ??= this.runDisposal()
		return this.disposal
	}

	private async runDisposal(): Promise<void> {
		hooks.containers.delete(this)
		try {
			await disposeStore(this.store, this.what)
		} finally {
			// A replacement either finishes tearing down the old generation or discards its proposal.
			await Promise.all(this.work)
		}
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
