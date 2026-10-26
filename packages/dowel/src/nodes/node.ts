/**
 * Runtime representation of graph nodes.
 *
 * Public types (`Scope`, `Slot`, `Service`, `Execution`, `Binding`) are plain
 * interfaces; the runtime data lives behind the `internal` symbol so it stays
 * out of hovers and autocompletion while remaining inspectable in a debugger.
 */

import type { ServiceContext } from '../api.ts'
import type { Deps } from '../model/declarations.ts'

/**
 * Local to this copy of dowel: ids and `ROOT` are per copy too, so nodes from
 * another copy must not pass for ours.
 */
export const internal: unique symbol = Symbol('dowel.internal')

let nextId = 0

export type Factory = (deps: Record<string, unknown>, ctx: ServiceContext) => unknown

export interface ScopeNode {
	readonly kind: 'scope'
	readonly id: number
	readonly name: string
	readonly parent: ScopeNode | null
	/** `root` is 0; each scope below adds one. */
	readonly depth: number
}

export interface SlotNode {
	readonly kind: 'slot'
	readonly id: number
	readonly name: string
	readonly scope: ScopeNode
	readonly many: boolean
}

export interface ServiceNode {
	readonly kind: 'service'
	readonly id: number
	readonly name: string
	readonly scope: ScopeNode
	readonly deps: Deps
	readonly factory: Factory
}

export interface ExecutionNode {
	readonly kind: 'execution'
	readonly id: number
	readonly name: string
	/** The scope each run opens a container for; the runner lives in its parent. */
	readonly scope: ScopeNode
	readonly entry: SlotNode | ServiceNode
	readonly inputs: readonly ExecutionInput[]
}

/** A slot each run of an execution supplies, under the key the runner takes its value by. */
export interface ExecutionInput {
	readonly key: string
	readonly slot: SlotNode
}

/** A value or a service standing in for a slot, a contribution, or an overridden node. */
export type ImplNode =
	| { readonly kind: 'value'; readonly value: unknown }
	| { readonly kind: 'service'; readonly service: ServiceNode }

/** A slot bound to an implementation, or a contribution to a multi-binding slot. */
export interface BindingNode {
	readonly kind: 'binding'
	readonly slot: SlotNode
	readonly impl: ImplNode
}

export type Node = ScopeNode | SlotNode | ServiceNode | ExecutionNode | BindingNode

/** A node that has a name and can be depended on or resolved. */
export type DeclaredNode = SlotNode | ServiceNode | ExecutionNode

/** Any object carrying runtime node data. */
export interface Carrier<N extends Node = Node> {
	readonly [internal]: N
}

const KINDS: ReadonlySet<string> = new Set(['scope', 'slot', 'service', 'execution', 'binding'])

export function allocateId(): number {
	return nextId++
}

export const ROOT: ScopeNode = {
	kind: 'scope',
	id: allocateId(),
	name: 'root',
	parent: null,
	depth: 0,
}

export function isCarrier(value: unknown): value is Carrier {
	if (typeof value !== 'object' || value === null || !(internal in value)) return false
	const node = (value as Partial<Carrier>)[internal]
	return typeof node === 'object' && node !== null && KINDS.has(node.kind)
}

/** `Slot 'Logger'`, `Service 'Users'`, `Scope 'request'`, or the binding's slot. */
export function describe(node: Node): string {
	switch (node.kind) {
		case 'slot':
			return `Slot '${node.name}'`
		case 'service':
			return `Service '${node.name}'`
		case 'execution':
			return `Execution '${node.name}'`
		case 'scope':
			return `Scope '${node.name}'`
		case 'binding':
			return `Binding for '${node.slot.name}'`
	}
}
