/** What compilation produces: plans naming their dependencies' plans directly, so resolution does no lookups. */

import type { ExecutionInput, Factory, ScopeNode, SlotNode } from '../nodes/node.ts'

/** An edge to a dependency: the key a factory receives it under, and whether it was declared optional. */
export interface PlanDep {
	readonly key: string
	readonly plan: Plan
	readonly optional: boolean
}

interface PlanBase {
	readonly name: string
	readonly scope: ScopeNode
	readonly deps: readonly PlanDep[]
}

/** A service: its factory runs once per store in its scope, and the instance is kept in `cell`. */
export interface ServicePlan extends PlanBase {
	readonly kind: 'service'
	readonly cell: number
	readonly factory: Factory
}

/** A multi-binding: its contributions, collected once per store in its scope into `cell`. */
export interface ManyPlan extends PlanBase {
	readonly kind: 'many'
	readonly cell: number
}

/** A bound or overriding value, or an absent optional slot. */
export interface ValuePlan extends PlanBase {
	readonly kind: 'value'
	readonly value: unknown
}

/** A scoped slot whose value `open()` writes into `cell` of its scope's store. */
export interface ScopeValuePlan extends PlanBase {
	readonly kind: 'scopeValue'
	readonly slot: SlotNode
	readonly cell: number
}

/** An execution: resolves to a runner that opens a container for `child` on each run. */
export interface ExecutionPlan extends PlanBase {
	readonly kind: 'execution'
	readonly entry: Plan
	readonly child: ScopePlan
	/** The slots each run supplies, by the key the runner takes each value by. */
	readonly inputs: readonly ExecutionInput[]
	/** What each run's container initializes and requires: the entry, and the slots of `child` it needs. */
	readonly needs: ScopeNeeds
}

export type Plan = ServicePlan | ManyPlan | ValuePlan | ScopeValuePlan | ExecutionPlan

/** A plan whose instance is created once per store in its scope and kept in a cell. */
export type CachedPlan = ServicePlan | ManyPlan

export function isCached(plan: Plan): plan is CachedPlan {
	return plan.kind === 'service' || plan.kind === 'many'
}

/** What opening a container initializes and requires: for `open()` what the roots reach in the scope, for a run its entry. */
export interface ScopeNeeds {
	/** Cached plans to create, in dependency order; creating one creates what it reaches. */
	readonly order: readonly CachedPlan[]
	/** Scoped slots in the scope that must be supplied, by name. */
	readonly required: ReadonlySet<string>
}

/** What a store at one scope needs to know. */
export interface ScopePlan {
	readonly scope: ScopeNode
	/** How many cells a store in this scope has. */
	readonly cells: number
	/** Scoped slots supplied when a container for this scope opens, by name. Optional ones may be omitted. */
	readonly values: ReadonlyMap<string, ScopeValuePlan>
	/** Slots in this scope whose value build() decides, by name; open() cannot supply them. */
	readonly bound: ReadonlyMap<string, SlotNode>
	/** Every cached plan in the scope, in dependency order, whether created eagerly or on demand. */
	readonly cached: readonly CachedPlan[]
	/** What `open()` initializes and requires: what the provided nodes reach, outside executions. */
	readonly needs: ScopeNeeds
}

/** A scope nothing in the graph lives in can still be opened; it holds nothing. */
export function emptyScopePlan(scope: ScopeNode): ScopePlan {
	return {
		scope,
		cells: 0,
		values: new Map(),
		bound: new Map(),
		cached: [],
		needs: { order: [], required: new Set() },
	}
}

/** How a slot's value arrives, or what an overridden service was replaced with. */
export type BindingInfo =
	| ImplInfo
	| { readonly kind: 'scope' }
	| { readonly kind: 'absent' }
	| { readonly kind: 'many'; readonly items: readonly ImplInfo[] }

/** A value, or the service standing in for a node. */
export type ImplInfo =
	| { readonly kind: 'service'; readonly id: number }
	| { readonly kind: 'value' }

/** A node of the graph as declared, for introspection. */
export interface GraphNode {
	readonly id: number
	readonly kind: 'service' | 'slot' | 'execution'
	readonly name: string
	readonly scope: ScopeNode
	readonly many: boolean
	/** Dependencies by key, as node ids. */
	readonly deps: readonly { readonly key: string; readonly id: number }[]
	readonly binding: BindingInfo | null
	readonly plan: Plan
}

export interface Compiled {
	readonly plans: ReadonlyMap<number, Plan>
	readonly graph: readonly GraphNode[]
	/** Scope plans by scope name. Always contains `root`. */
	readonly scopes: ReadonlyMap<string, ScopePlan>
	/** What the roots reach outside executions; of the cached plans, only these are created with their container, and so resolvable with `get()`. */
	readonly eager: ReadonlySet<Plan>
}
