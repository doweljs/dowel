import type { ServiceContext } from '../api.ts'
import { DowelError } from '../errors.ts'
import type { DeclaredNames, DeclaredScope, LiteralName } from '../model/checks.ts'
import type { AnyScope, Deps, Service } from '../model/declarations.ts'
import type { ScopeAboveDependencies } from '../model/diagnostics.ts'
import type { ComputeMeta, MetaOf, Resolved } from '../model/infer.ts'
import type { CheckScopes, EffectiveScope, InferredScope } from '../model/scopes.ts'
import { dependencyOf, scopeNode, usableScope } from '../nodes/coerce.ts'
import { deeper, isAtOrAbove } from '../nodes/lineage.ts'
import {
	allocateId,
	type Factory,
	internal,
	ROOT,
	type ScopeNode,
	type ServiceNode,
} from '../nodes/node.ts'

type CheckScope<D extends Deps, Sc extends AnyScope> = InferredScope<D>['name'] extends
	| MetaOf<Sc>['name']
	| MetaOf<Sc>['above']
	? unknown
	: ScopeAboveDependencies<MetaOf<Sc>['name'], InferredScope<D>['name']>

export interface ServiceOptions<D extends Deps, Sc extends AnyScope> {
	/**
	 * Keep the instance in a deeper scope than its dependencies imply, for
	 * example one unit of work per request although it only needs the
	 * database. By default a service lives in the deepest scope among its
	 * dependencies: at the container when they are all root-scope.
	 */
	readonly scope?: Sc & DeclaredScope<Sc> & CheckScope<D, Sc>
}

type ExplicitScope<Sc extends AnyScope> = [Sc] extends [never] ? never : MetaOf<Sc>

/**
 * Declare a concrete service.
 *
 * Dependencies are declared as values, so the service's requirements and
 * scope are inferred and checked by the compiler. One instance exists per
 * container, or per container opened for the service's scope.
 *
 * ```ts
 * const Users = service('Users', { db: Db, log: Logger }, ({ db, log }) => ({
 *   list: () => db.query('select * from users'),
 * }))
 * ```
 */
export function service<N extends string, R, Sc extends AnyScope = never>(
	name: LiteralName<N>,
	factory: (ctx: ServiceContext) => R,
	options?: ServiceOptions<{}, Sc>,
): Service<Awaited<R>, ComputeMeta<N, {}, EffectiveScope<{}, ExplicitScope<Sc>>>>
export function service<N extends string, const D extends Deps, R, Sc extends AnyScope = never>(
	name: LiteralName<N>,
	deps: D & CheckScopes<D> & DeclaredNames<D>,
	factory: (deps: Resolved<D>, ctx: ServiceContext) => R,
	options?: ServiceOptions<D, Sc>,
): Service<Awaited<R>, ComputeMeta<N, D, EffectiveScope<D, ExplicitScope<Sc>>>>
export function service(name: string, ...rest: unknown[]): unknown {
	const standalone = typeof rest[0] === 'function'
	const [deps, factory, options] = (
		standalone
			? [{}, (_deps: unknown, ctx: ServiceContext) => (rest[0] as Function)(ctx), rest[1]]
			: rest
	) as [Deps, Factory, { readonly scope?: AnyScope } | undefined]

	let inferred: ScopeNode = ROOT
	for (const [key, dep] of Object.entries(deps)) {
		let scope: ScopeNode
		try {
			scope = usableScope(dependencyOf(dep).node)
		} catch (cause) {
			throw new DowelError('INVALID_NODE', `Dependency '${key}' of '${name}' is invalid.`, {
				cause,
			})
		}
		const next = deeper(inferred, scope)
		if (next === null) {
			throw new DowelError(
				'CAPTIVE_DEPENDENCY',
				`Service '${name}' depends on '${key}' in scope '${scope.name}' and on another dependency in scope '${inferred.name}', which are on different scope branches.`,
			)
		}
		inferred = next
	}

	const explicit = options?.scope === undefined ? null : scopeNode(options.scope)
	if (explicit !== null && !isAtOrAbove(inferred, explicit)) {
		throw new DowelError(
			'CAPTIVE_DEPENDENCY',
			deeper(inferred, explicit) === null
				? `Service '${name}' is declared in scope '${explicit.name}' but a dependency lives in '${inferred.name}', which is on a different scope branch.`
				: `Service '${name}' is declared in scope '${explicit.name}' but a dependency lives in '${inferred.name}', below it.`,
		)
	}
	const scope = explicit ?? inferred

	const node: ServiceNode = {
		kind: 'service',
		id: allocateId(),
		name,
		scope,
		// Copied, so changing the object afterwards cannot change the graph its scope was checked against.
		deps: Object.freeze({ ...deps }),
		factory,
	}
	return Object.freeze({
		'~kind': 'service',
		name,
		scope: scope.name,
		[internal]: node,
	}) as Service<unknown, any>
}
