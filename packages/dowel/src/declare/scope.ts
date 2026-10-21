import { DowelError } from '../errors.ts'
import type { DeclaredScope, Named } from '../model/checks.ts'
import type { AnyScope, Scope, ScopeMeta } from '../model/declarations.ts'
import type { ReservedScopeName } from '../model/diagnostics.ts'
import type { MetaOf } from '../model/infer.ts'
import { scopeNode } from '../nodes/coerce.ts'
import { allocateId, internal, ROOT, type ScopeNode } from '../nodes/node.ts'

/**
 * The scope declared as `N`. The container's own scope name, `root`, is
 * rejected at the type level too: scopes are identified by name.
 */
type Declared<N extends string, M extends ScopeMeta> = [N] extends ['root']
	? ReservedScopeName<N>
	: Named<N, Scope<M>>

/**
 * Declare a scope: a lifetime shorter than the container's, such as one
 * request. Scopes nest: a scope's parent is the scope whose containers open
 * it. Without a parent, a scope sits directly under the container's own
 * `root` scope.
 *
 * ```ts
 * export const Session = scope('session')
 * export const Request = scope('request', Session)
 * ```
 *
 * A slot declared in a scope is supplied when a container for that scope is
 * opened, and every service depending on it lives in that scope.
 */
export function scope<N extends string>(
	name: N,
): Declared<N, { readonly name: N; readonly parent: 'root'; readonly above: 'root' }>
export function scope<N extends string, P extends AnyScope>(
	name: N,
	parent: P & DeclaredScope<P>,
): Declared<
	N,
	{
		readonly name: N
		readonly parent: MetaOf<P>['name']
		readonly above: MetaOf<P>['name'] | MetaOf<P>['above']
	}
>
export function scope(name: string, parent?: AnyScope): unknown {
	if (name === ROOT.name) {
		throw new DowelError(
			'INVALID_SCOPE',
			`Scope name '${name}' is reserved for the container's own scope. Choose another name.`,
		)
	}
	const parentNode = parent === undefined ? ROOT : scopeNode(parent)
	const node: ScopeNode = {
		kind: 'scope',
		id: allocateId(),
		name,
		parent: parentNode,
		depth: parentNode.depth + 1,
	}
	return Object.freeze({ '~kind': 'scope', name, [internal]: node })
}
