/**
 * Turns a composition (roots, bindings, contributions and overrides) into
 * plans.
 *
 * Compilation walks the graph from the roots, validates it (unbound slots,
 * captive dependencies, cycles, duplicate names, scope mismatches, execution
 * inputs) and produces one `Plan` per reached node, allocating each cached
 * plan a cell in the stores of its scope. Bindings that nothing reaches are
 * never compiled, so they never activate.
 */

import { DowelError, formatPath } from '../errors.ts'
import { dependencyOf } from '../nodes/coerce.ts'
import { assertImplScope, isAtOrAbove, scopeNames } from '../nodes/lineage.ts'
import {
	type DeclaredNode,
	type ExecutionNode,
	type ImplNode,
	ROOT,
	type ScopeNode,
	type ServiceNode,
	type SlotNode,
} from '../nodes/node.ts'
import type {
	BindingInfo,
	CachedPlan,
	Compiled,
	ExecutionPlan,
	GraphNode,
	ImplInfo,
	ManyPlan,
	Plan,
	PlanDep,
	ScopeNeeds,
	ScopePlan,
	ScopeValuePlan,
	ServicePlan,
	ValuePlan,
} from './plan.ts'

/** Everything a builder accumulates. Immutable once a container is built from it. */
export interface Composition {
	/** Services, executions and slots activation starts from. */
	readonly roots: readonly DeclaredNode[]
	readonly bindings: ReadonlyMap<SlotNode, ImplNode>
	readonly contributions: ReadonlyMap<SlotNode, readonly ImplNode[]>
	readonly overrides: ReadonlyMap<SlotNode | ServiceNode, ImplNode>
}

/** Maps a node to the one that should stand in for it (used by hot replacement). */
export type Canonicalize = <N extends DeclaredNode | ScopeNode>(node: N) => N

export interface CompileOptions {
	readonly canonical?: Canonicalize
}

/** A scope plan while compilation still adds to it. */
interface ScopeDraft extends ScopePlan {
	cells: number
	readonly values: Map<string, ScopeValuePlan>
	readonly bound: Set<string>
	readonly needs: { readonly order: CachedPlan[]; readonly required: Set<string> }
}

const identity: Canonicalize = (node) => node

export function compile(composition: Composition, options: CompileOptions = {}): Compiled {
	return new Compiler(composition, options.canonical ?? identity).compile()
}

class Compiler {
	private readonly plans = new Map<number, Plan>()
	private readonly graph: GraphNode[] = []
	private readonly scopes = new Map<string, ScopeDraft>()
	private readonly roots: DeclaredNode[]
	private readonly bindings = new Map<SlotNode, ImplNode>()
	private readonly contributions = new Map<SlotNode, ImplNode[]>()
	/** Multi-binding slots whose whole set an override replaces. */
	private readonly manyOverrides = new Map<SlotNode, ImplNode>()
	private readonly serviceOverrides = new Map<ServiceNode, ImplNode>()
	private readonly appliedOverrides = new Set<ServiceNode>()
	/** Slots only ever depended on optionally and left unbound; a required usage must still fail. */
	private readonly absent = new Set<number>()
	/** Node ids by name, to reject two distinct nodes sharing a name. */
	private readonly names = new Map<string, number>()
	/** Names on the current dependency path, for cycle detection and messages. */
	private readonly path: string[] = []
	private readonly visiting = new Set<number>()

	constructor(
		composition: Composition,
		private readonly canonical: Canonicalize,
	) {
		this.roots = composition.roots.map(canonical)
		for (const [slot, impl] of composition.bindings) {
			this.bindings.set(canonical(slot), this.canonicalImpl(impl))
		}
		for (const [slot, impls] of composition.contributions) {
			this.contributions.set(
				canonical(slot),
				impls.map((impl) => this.canonicalImpl(impl)),
			)
		}
		for (const [target, replacement] of composition.overrides) {
			this.registerOverride(canonical(target), this.canonicalImpl(replacement))
		}
		this.scopeDraft(ROOT)
	}

	/** Slot overrides replace bindings or contribution sets up front; service overrides apply while planning. */
	private registerOverride(node: SlotNode | ServiceNode, impl: ImplNode): void {
		if (node.kind === 'service') {
			this.serviceOverrides.set(node, impl)
			return
		}
		if (node.many) {
			// A multi-binding resolves even without contributions (to []), so there is always something to replace.
			this.manyOverrides.set(node, impl)
		} else {
			if (!this.bindings.has(node)) {
				throw new DowelError(
					'UNKNOWN_OVERRIDE',
					`Slot '${node.name}' is not bound, so there is nothing to override.`,
				)
			}
			this.bindings.set(node, impl)
		}
		// Like a binding nothing reaches, an unreachable slot override is never compiled.
	}

	compile(): Compiled {
		for (const root of this.roots) this.planNode(root, false)

		for (const target of this.serviceOverrides.keys()) {
			if (!this.appliedOverrides.has(target)) {
				throw new DowelError(
					'UNKNOWN_OVERRIDE',
					`Service '${target.name}' is overridden but is not reachable from the roots.`,
				)
			}
		}
		return { plans: this.plans, graph: this.graph, scopes: this.scopes }
	}

	private planNode(node: DeclaredNode, optional: boolean): Plan {
		switch (node.kind) {
			case 'slot':
				return this.planSlot(node, optional)
			case 'service':
				return this.planService(node)
			case 'execution':
				return this.planExecution(node)
		}
	}

	private scopeDraft(scope: ScopeNode): ScopeDraft {
		const node = this.canonical(scope)
		const existing = this.scopes.get(node.name)
		if (existing !== undefined) {
			if (existing.scope !== node) {
				throw new DowelError(
					'DUPLICATE',
					`Two distinct scopes are named '${node.name}'. Scope names must be unique within a container.`,
				)
			}
			return existing
		}
		if (node.parent !== null) this.scopeDraft(node.parent)
		const draft: ScopeDraft = {
			scope: node,
			cells: 0,
			values: new Map(),
			bound: new Set(),
			needs: { order: [], required: new Set() },
		}
		this.scopes.set(node.name, draft)
		return draft
	}

	private canonicalImpl(impl: ImplNode): ImplNode {
		return impl.kind === 'value' ? impl : { kind: 'service', service: this.canonical(impl.service) }
	}

	private claimName(node: DeclaredNode): void {
		const owner = this.names.get(node.name)
		if (owner !== undefined && owner !== node.id) {
			throw new DowelError(
				'DUPLICATE',
				`Two distinct nodes are named '${node.name}'. Names must be unique within a container.`,
			)
		}
		this.names.set(node.name, node.id)
	}

	/** Runs `build` for a node with the cycle guard and path bookkeeping in place, and remembers its plan. */
	private visit<P extends Plan>(node: DeclaredNode, build: () => P): P {
		if (this.visiting.has(node.id)) {
			throw new DowelError(
				'CYCLE',
				`Dependency cycle: ${formatPath([...this.path, node.name])}. Cycles can only arise from overrides or executions.`,
			)
		}
		this.claimName(node)
		this.visiting.add(node.id)
		this.path.push(node.name)
		try {
			const plan = build()
			this.plans.set(node.id, plan)
			return plan
		} finally {
			this.path.pop()
			this.visiting.delete(node.id)
		}
	}

	private planService(declared: ServiceNode): Plan {
		return (
			this.plans.get(declared.id) ??
			this.visit(declared, () => {
				const override = this.serviceOverrides.get(declared)
				return override === undefined
					? this.buildService(declared)
					: this.buildOverride(declared, override)
			})
		)
	}

	/** The overridden node stays resolvable and visible, pointing at its replacement. */
	private buildOverride(declared: ServiceNode, override: ImplNode): Plan {
		this.appliedOverrides.add(declared)
		const scope = this.canonical(declared.scope)
		const plan = this.planImpl(declared.name, scope, override)
		this.record(declared, scope, plan, [], implInfo(override))
		return plan
	}

	/** The plan for a value or service standing in for a node at `scope`. */
	private planImpl(name: string, scope: ScopeNode, impl: ImplNode): Plan {
		if (impl.kind === 'value') {
			return valuePlan(name, scope, impl.value)
		}
		const plan = this.planService(impl.service)
		assertImplScope({ name, scope }, impl, 'implementation')
		return plan
	}

	private planSlot(slot: SlotNode, optional: boolean): Plan {
		const existing = this.plans.get(slot.id)
		if (existing !== undefined) {
			if (optional) return existing
			if (this.absent.has(slot.id)) {
				throw new DowelError(
					'UNBOUND_SLOT',
					`Slot '${slot.name}' is not bound. Needed by ${formatPath([...this.path, slot.name])}.`,
				)
			}
			if (existing.kind === 'scopeValue') this.scopeDraft(slot.scope).needs.required.add(slot.name)
			return existing
		}
		return this.visit(slot, () => {
			const scope = this.canonical(slot.scope)
			const { plan, binding, deps } = slot.many
				? this.buildMany(slot, scope)
				: this.buildSlot(slot, scope, optional)
			this.record(slot, scope, plan, deps, binding)
			return plan
		})
	}

	private buildSlot(
		slot: SlotNode,
		scope: ScopeNode,
		optional: boolean,
	): { plan: Plan; binding: BindingInfo; deps: GraphNode['deps'] } {
		const impl = this.bindings.get(slot)
		if (impl !== undefined) {
			if (scope !== ROOT) this.scopeDraft(scope).bound.add(slot.name)
			return { plan: this.planImpl(slot.name, scope, impl), binding: implInfo(impl), deps: [] }
		}
		if (scope !== ROOT) {
			return {
				plan: this.buildScopeValue(slot, scope, !optional),
				binding: { kind: 'scope' },
				deps: [],
			}
		}
		if (optional) {
			this.absent.add(slot.id)
			return {
				plan: valuePlan(slot.name, ROOT, undefined),
				binding: { kind: 'absent' },
				deps: [],
			}
		}
		throw new DowelError(
			'UNBOUND_SLOT',
			`Slot '${slot.name}' is not bound. Needed by ${formatPath(this.path)}.`,
		)
	}

	private buildMany(
		slot: SlotNode,
		scope: ScopeNode,
	): { plan: Plan; binding: BindingInfo; deps: GraphNode['deps'] } {
		const override = this.manyOverrides.get(slot)
		if (override !== undefined) {
			return {
				plan: this.planImpl(slot.name, scope, override),
				binding: implInfo(override),
				deps: [],
			}
		}
		const items = this.contributions.get(slot) ?? []
		const deps = items.map((impl, index) => ({
			key: String(index),
			plan: this.planImpl(`${slot.name}[${index}]`, scope, impl),
			optional: false,
		}))
		const plan: ManyPlan = {
			kind: 'many',
			name: slot.name,
			scope,
			deps,
			cell: this.allocate(scope),
		}
		this.addCached(plan)
		return {
			plan,
			binding: { kind: 'many', items: items.map(implInfo) },
			// Contributed values are not nodes; `binding.items` lists them.
			deps: items.flatMap((impl, index) =>
				impl.kind === 'service' ? [{ key: String(index), id: impl.service.id }] : [],
			),
		}
	}

	/** Optional usages read `undefined` when no value was supplied. */
	private buildScopeValue(slot: SlotNode, scope: ScopeNode, required: boolean): ScopeValuePlan {
		const draft = this.scopeDraft(scope)
		const plan: ScopeValuePlan = {
			kind: 'scopeValue',
			name: slot.name,
			scope,
			deps: [],
			cell: this.allocate(scope),
		}
		draft.values.set(slot.name, plan)
		if (required) draft.needs.required.add(slot.name)
		return plan
	}

	private planExecution(declared: ExecutionNode): Plan {
		return this.plans.get(declared.id) ?? this.visit(declared, () => this.buildExecution(declared))
	}

	private buildExecution(declared: ExecutionNode): ExecutionPlan {
		const child = this.canonical(declared.scope)
		// The child's parent link may predate a re-declaration of the parent scope.
		const parent = this.canonical(child.parent ?? ROOT)
		const childDraft = this.scopeDraft(child)
		const inputs = declared.inputs.map(({ key, slot }) => ({ key, slot: this.canonical(slot) }))
		const slots = inputs.map((input) => input.slot)
		this.assertUnbound(declared, slots)
		const entryNode = this.canonical(declared.entry)
		const entry = this.planNode(entryNode, false)
		if (!isAtOrAbove(entry.scope, child)) {
			const [runs, lives] = scopeNames(child, entry.scope)
			throw new DowelError(
				'CAPTIVE_DEPENDENCY',
				`Execution '${declared.name}' runs in scope '${runs}' but its entry '${entry.name}' lives in '${lives}', which is not visible from there.`,
			)
		}
		const needs = needsOf(entry, childDraft)
		assertSupplied(declared, needs, slots)

		const plan: ExecutionPlan = {
			kind: 'execution',
			id: declared.id,
			name: declared.name,
			scope: parent,
			deps: [{ key: 'entry', plan: entry, optional: false }],
			entry,
			child: childDraft,
			inputs,
			needs,
		}
		const edges = [
			{ key: 'entry', id: entryNode.id },
			...inputs.map(({ key, slot }) => ({ key, id: slot.id })),
		]
		this.record(declared, parent, plan, edges, null)
		for (const slot of slots) this.planSlot(slot, true)
		return plan
	}

	/** Each run supplies an execution's inputs, so build() must not bind them too. */
	private assertUnbound(execution: ExecutionNode, inputs: readonly SlotNode[]): void {
		for (const input of inputs) {
			if (this.bindings.has(input) || this.contributions.has(input)) {
				throw new DowelError(
					'DUPLICATE',
					`Slot '${input.name}' is an input of execution '${execution.name}', so each run supplies it. It cannot also be bound at build().`,
				)
			}
		}
	}

	private buildService(node: ServiceNode): Plan {
		const scope = this.canonical(node.scope)
		const deps: PlanDep[] = []
		const edges: { key: string; id: number }[] = []
		for (const [key, dep] of Object.entries(node.deps)) {
			const dependency = dependencyOf(dep)
			const target = this.canonical(dependency.node)
			const plan = this.planNode(target, dependency.optional)
			if (!isAtOrAbove(plan.scope, scope)) {
				const [lives, depends] = scopeNames(scope, plan.scope)
				throw new DowelError(
					'CAPTIVE_DEPENDENCY',
					`Service '${node.name}' lives in scope '${lives}' but depends on '${plan.name}' in '${depends}', which it cannot see.`,
				)
			}
			deps.push({ key, plan, optional: dependency.optional })
			edges.push({ key, id: target.id })
		}

		const { factory, name } = node
		const plan: ServicePlan = {
			kind: 'service',
			name,
			scope,
			deps,
			cell: this.allocate(scope),
			factory,
		}
		this.addCached(plan)
		this.record(node, scope, plan, edges, null)
		return plan
	}

	/** Reserves a cell in the stores of `scope`. */
	private allocate(scope: ScopeNode): number {
		return this.scopeDraft(scope).cells++
	}

	/** Adds a node to the graph `inspect()` reports. */
	private record(
		node: DeclaredNode,
		scope: ScopeNode,
		plan: Plan,
		deps: GraphNode['deps'],
		binding: BindingInfo | null,
	): void {
		const many = node.kind === 'slot' && node.many
		this.graph.push({
			id: node.id,
			kind: node.kind,
			name: node.name,
			scope,
			many,
			deps,
			binding,
			plan,
		})
	}

	/** Adds a cached plan to its scope's initialization order, after the dependencies planned before it. */
	private addCached(plan: CachedPlan): void {
		this.scopeDraft(plan.scope).needs.order.push(plan)
	}
}

function valuePlan(name: string, scope: ScopeNode, value: unknown): ValuePlan {
	return { kind: 'value', name, scope, deps: [], value }
}

/**
 * What a run at `scope` needs from its own store to resolve `entry`: the
 * cached plans there that `entry` reaches, and the scoped slots there it
 * reaches through required dependencies. A nested execution whose scopes
 * open at `scope` or above resolves those from its own store, so it is not
 * followed.
 */
function needsOf(entry: Plan, scope: ScopePlan): ScopeNeeds {
	const { depth } = scope.scope
	const reached = new Set<Plan>()
	const required = new Set<string>()
	const walk = (current: Plan, optional: boolean): void => {
		if (current.kind === 'scopeValue') {
			if (current.scope === scope.scope && !optional) required.add(current.name)
			return
		}
		if (reached.has(current)) return
		reached.add(current)
		if (current.kind === 'execution' && current.scope.depth < depth) return
		for (const dep of current.deps) walk(dep.plan, dep.optional)
	}
	walk(entry, false)
	return { order: scope.needs.order.filter((plan) => reached.has(plan)), required }
}

/** An execution's inputs must cover the scoped slots its entry requires in the execution's scope. */
function assertSupplied(
	execution: ExecutionNode,
	needs: ScopeNeeds,
	inputs: readonly SlotNode[],
): void {
	const supplied = new Set(inputs.map((input) => input.name))
	const missing = [...needs.required].filter((name) => !supplied.has(name))
	if (missing.length === 0) return
	throw new DowelError(
		'MISSING_SCOPE_VALUE',
		`Execution '${execution.name}' needs ${missing.map((name) => `'${name}'`).join(', ')} in scope '${execution.scope.name}', which its inputs do not supply. Add them to its inputs.`,
	)
}

function implInfo(impl: ImplNode): ImplInfo {
	return impl.kind === 'value' ? { kind: 'value' } : { kind: 'service', id: impl.service.id }
}
