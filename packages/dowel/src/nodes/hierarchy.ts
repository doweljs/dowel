/**
 * How scopes relate. A scope is the object `scope()` returned: two
 * declarations are two scopes, and two distinct scopes sharing a name are
 * rejected wherever they meet, since one of them is a duplicate.
 */

import { DowelError } from '../errors.ts'
import type { ImplNode, ScopeNode } from './node.ts'

/** Whether `ancestor` is `scope` itself or one of its ancestors. */
export function isAtOrAbove(ancestor: ScopeNode, scope: ScopeNode): boolean {
	let current: ScopeNode | null = scope
	while (current !== null && current.depth > ancestor.depth) current = current.parent
	return current === ancestor
}

/** The deeper of two scopes on one branch, or null when they are on different branches. */
export function deeper(a: ScopeNode, b: ScopeNode): ScopeNode | null {
	if (isAtOrAbove(a, b)) return b
	if (isAtOrAbove(b, a)) return a
	return null
}

/**
 * Rejects two distinct scopes that share a name, among `a`, `b` and their
 * ancestors, which `subject` brought together. Called where a check between
 * two scopes failed: a namesake is then the problem to report, since no
 * message about how the two relate would make sense.
 */
export function assertDistinctNames(a: ScopeNode, b: ScopeNode, subject: string): void {
	// A chain never repeats a name (see `scope()`), so one entry per name covers it.
	const byName = new Map<string, ScopeNode>()
	for (let current: ScopeNode | null = a; current !== null; current = current.parent) {
		byName.set(current.name, current)
	}
	for (let current: ScopeNode | null = b; current !== null; current = current.parent) {
		const other = byName.get(current.name)
		if (other !== undefined && other !== current) {
			throw new DowelError(
				'DUPLICATE',
				`${subject} meets two distinct scopes named '${current.name}'. Declare a scope once and import it where it is used; a module that declares it may have been loaded twice.`,
			)
		}
	}
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
	assertDistinctNames(impl.service.scope, target.scope, `The ${role} of '${target.name}'`)
	throw new DowelError(
		'CAPTIVE_DEPENDENCY',
		`Service '${impl.service.name}' lives in scope '${impl.service.scope.name}', which '${target.name}' in '${target.scope.name}' cannot see, so it cannot be its ${role}. Use a service in '${target.scope.name}' or above.`,
	)
}
