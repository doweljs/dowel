/**
 * How scopes relate. Scopes are compared by lineage, the names from the root
 * down, so a scope that earlier code still holds, from an evaluation before a
 * reload or another copy of dowel, matches the one a successor declares.
 */

import { DowelError } from '../errors.ts'
import type { ImplNode, ScopeNode } from './node.ts'

/**
 * Whether `ancestor` is `scope` itself or one of its ancestors, compared by
 * lineage (see {@link sameLineage}).
 */
export function isAtOrAbove(ancestor: ScopeNode, scope: ScopeNode): boolean {
	let current: ScopeNode | null = scope
	while (current !== null && current.depth > ancestor.depth) current = current.parent
	return current !== null && sameLineage(ancestor, current)
}

/** The deeper of two scopes on one branch, or null when they are on different branches. */
export function deeper(a: ScopeNode, b: ScopeNode): ScopeNode | null {
	if (isAtOrAbove(a, b)) return b
	if (isAtOrAbove(b, a)) return a
	return null
}

/**
 * Whether two scopes have the same names from the root down. Two copies of
 * a scope, one of them from earlier code, are the same scope; two distinct
 * scopes sharing a lineage in one container are rejected when it is built.
 */
export function sameLineage(a: ScopeNode, b: ScopeNode): boolean {
	if (a.depth !== b.depth) return false
	let x: ScopeNode | null = a
	let y: ScopeNode | null = b
	for (; x !== null && y !== null; x = x.parent, y = y.parent) {
		if (x === y) return true
		if (x.name !== y.name) return false
	}
	return x === y
}

/**
 * Names two scopes for one message: by name, or by lineage
 * (`root/session/request`) when two different scopes share a name.
 */
export function scopeNames(a: ScopeNode, b: ScopeNode): [string, string] {
	return a.name === b.name && !sameLineage(a, b) ? [lineageOf(a), lineageOf(b)] : [a.name, b.name]
}

function lineageOf(scope: ScopeNode): string {
	const names: string[] = []
	for (let current: ScopeNode | null = scope; current !== null; current = current.parent) {
		names.unshift(current.name)
	}
	return names.join('/')
}

/**
 * A service may only stand in for a node (implement a slot, contribute to a
 * multi-binding, override a node) if it lives in that node's scope or above.
 */
export function assertImplScope(
	target: { readonly name: string; readonly scope: ScopeNode },
	impl: ImplNode,
	role: string,
): void {
	if (impl.kind === 'value' || isAtOrAbove(impl.service.scope, target.scope)) return
	const [lives, needed] = scopeNames(impl.service.scope, target.scope)
	throw new DowelError(
		'CAPTIVE_DEPENDENCY',
		`Service '${impl.service.name}' lives in scope '${lives}', which '${target.name}' in '${needed}' cannot see, so it cannot be its ${role}. Use a service in '${needed}' or above.`,
	)
}
