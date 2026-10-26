import { DowelError } from '../errors.ts'
import type { DeclaredScope, ScopeName } from '../model/checks.ts'
import type { AnyScope, Scope } from '../model/declarations.ts'
import type { MetaOf } from '../model/infer.ts'
import { scopeNode } from '../nodes/coerce.ts'
import { allocateId, internal, ROOT, type ScopeNode } from '../nodes/node.ts'

/**
 * Declare a scope: a lifetime shorter than the container's, such as one
 * request, opened from containers of its parent (`root` without one).
 *
 * ```ts
 * export const Session = scope('session')
 * export const Request = scope('request', Session)
 * ```
 */
export function scope<N extends string>(
	name: ScopeName<N>,
): Scope<{ readonly name: N; readonly parent: 'root'; readonly above: 'root' }>
export function scope<N extends string, P extends AnyScope>(
	name: ScopeName<N>,
	parent: P & DeclaredScope<P>,
): Scope<{
	readonly name: N
	readonly parent: MetaOf<P>['name']
	readonly above: MetaOf<P>['name'] | MetaOf<P>['above']
}>
export function scope(name: string, parent?: AnyScope): unknown {
	if (name === ROOT.name) {
		throw new DowelError(
			'INVALID_SCOPE',
			`Scope name '${name}' is reserved for the container's own scope. Choose another name.`,
		)
	}
	const parentNode = parent === undefined ? ROOT : scopeNode(parent)
	for (let above: ScopeNode | null = parentNode; above !== null; above = above.parent) {
		if (above.name === name) {
			throw new DowelError(
				'INVALID_SCOPE',
				`Scope name '${name}' is already the name of a scope above it. Scope names must be unique along a chain.`,
			)
		}
	}
	const node: ScopeNode = {
		kind: 'scope',
		id: allocateId(),
		name,
		parent: parentNode,
		depth: parentNode.depth + 1,
	}
	return Object.freeze({ '~kind': 'scope', name, [internal]: node })
}
