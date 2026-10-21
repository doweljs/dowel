/**
 * Turns the values users pass (slots, services, bindings, dependency records)
 * into the runtime nodes behind them, rejecting anything else with a message
 * that says what was expected.
 */

import { DowelError } from '../errors.ts'
import type { AnySlot, Dep, Optional } from '../model/declarations.ts'
import {
	type BindingNode,
	type DeclaredNode,
	describe,
	type ImplNode,
	internal,
	isCarrier,
	type Node,
	ROOT,
	type ScopeNode,
	type SlotNode,
} from './node.ts'

export function nodeOf(value: unknown, what: string): Node {
	if (!isCarrier(value)) {
		throw new DowelError(
			'INVALID_NODE',
			fromOtherCopy(value)
				? `Expected ${what} to be a dowel node, but it was declared with a different copy of dowel. Make sure only one copy is installed.`
				: `Expected ${what} to be a dowel node.`,
		)
	}
	return value[internal]
}

function fromOtherCopy(value: unknown): boolean {
	return (
		typeof value === 'object' &&
		value !== null &&
		Object.getOwnPropertySymbols(value).some(
			(symbol) => symbol !== internal && symbol.description === 'dowel.internal',
		)
	)
}

function expectKind<K extends Node['kind']>(
	value: unknown,
	kind: K,
	what: string,
): Extract<Node, { kind: K }> {
	const node = nodeOf(value, what)
	if (node.kind !== kind) {
		throw new DowelError('INVALID_NODE', `Expected ${what} but received the ${describe(node)}.`)
	}
	return node as Extract<Node, { kind: K }>
}

export const slotNode = (value: unknown): SlotNode => expectKind(value, 'slot', 'a slot')
export const scopeNode = (value: unknown): ScopeNode => expectKind(value, 'scope', 'a scope')
export const bindingNode = (value: unknown): BindingNode =>
	expectKind(value, 'binding', 'a binding')

/** A slot, a service or an execution: what can be depended on and resolved. */
export function declaredNode(value: unknown, what: string): DeclaredNode {
	const node = nodeOf(value, what)
	if (node.kind === 'slot' || node.kind === 'service' || node.kind === 'execution') return node
	throw new DowelError(
		'INVALID_NODE',
		`Expected ${what} to be a slot, a service or an execution but received the ${describe(node)}.`,
	)
}

/** A service, or a plain value, as something that can stand in for a node. */
export function implOf(value: unknown): ImplNode {
	if (!isCarrier(value)) return { kind: 'value', value }
	const node = value[internal]
	if (node.kind === 'service') return { kind: 'service', service: node }
	// A slot, scope, execution or binding is never meant as a value; aliasing a slot is not supported.
	throw new DowelError(
		'INVALID_NODE',
		`${describe(node)} cannot stand in for another node. Bind a service or a value; to reuse another slot's implementation, bind the same service to both.`,
	)
}

/** The runtime node behind a dependency declaration, and whether it was declared optional. */
export interface Dependency {
	readonly node: DeclaredNode
	/** Only a slot can be optional. */
	readonly optional: boolean
}

export function dependencyOf(dep: Dep): Dependency {
	if (isOptional(dep)) return { node: slotNode(dep.slot), optional: true }
	return { node: declaredNode(dep, 'a dependency'), optional: false }
}

/** The scope a dependency is usable from: an execution's runner lives in its scope's parent. */
export function usableScope(node: DeclaredNode): ScopeNode {
	return node.kind === 'execution' ? (node.scope.parent ?? ROOT) : node.scope
}

function isOptional(dep: Dep): dep is Optional<AnySlot> {
	return (
		typeof dep === 'object' &&
		dep !== null &&
		(dep as { '~kind'?: unknown })['~kind'] === 'optional'
	)
}
