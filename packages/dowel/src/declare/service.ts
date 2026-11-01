import type { ServiceContext } from '../api.ts'
import { DowelError } from '../errors.ts'
import type { DeclaredNames, DeclaredScope, LiteralName } from '../model/checks.ts'
import type {
	AnyScope,
	Deps,
	Implementation,
	ItemOf,
	Service,
	SlotMeta,
} from '../model/declarations.ts'
import type { ScopeAboveDependencies } from '../model/diagnostics.ts'
import type { ComputeMeta, ImplementationMetaOf, MetaOf, Resolved } from '../model/infer.ts'
import type { CheckScopes, EffectiveScope, InferredScope } from '../model/scopes.ts'
import { dependencyOf, scopeNode, slotNode, usableScope } from '../nodes/coerce.ts'
import { assertDistinctNames, deeper, isAtOrAbove } from '../nodes/hierarchy.ts'
import {
	allocateId,
	type Factory,
	internal,
	ROOT,
	type ScopeNode,
	type ServiceNode,
	type SlotNode,
} from '../nodes/node.ts'

type CheckScope<D extends Deps, Sc extends AnyScope> = InferredScope<D>['name'] extends
	| MetaOf<Sc>['name']
	| MetaOf<Sc>['above']
	? unknown
	: ScopeAboveDependencies<MetaOf<Sc>['name'], InferredScope<D>['name']>

export interface ServiceOptions<D extends Deps, Sc extends AnyScope> {
	/** A deeper scope than the dependencies imply, such as one unit of work per request. Default: the deepest dependency's. */
	readonly scope?: Sc & DeclaredScope<Sc> & CheckScope<D, Sc>
}

type ExplicitScope<Sc extends AnyScope> = [Sc] extends [never] ? never : MetaOf<Sc>

/** What an implementation of a slot produces: one item of a multi-binding, otherwise the slot's type. */
type SlotValue<T, M extends SlotMeta> = M['many'] extends true ? ItemOf<T> : T

/**
 * `Slot.implement()`: a service that fills the slot, without a name of its
 * own. It stands for the slot it's bound to: its dependencies are listed under
 * that slot, so it can't be depended on, provided, resolved or overridden
 * itself. Use {@link SlotImplementAs} when something must refer to it.
 *
 * Its factory's result is checked against the slot, and it keeps its own type.
 * Without dependencies it takes no options, so the two forms never take the
 * same number of arguments: an error is then reported against the only form
 * that applies. Pass `{}` as the dependencies to give options.
 */
export interface SlotImplement<T, M extends SlotMeta> {
	<R extends SlotValue<T, M> | PromiseLike<SlotValue<T, M>>>(
		factory: (ctx: ServiceContext) => R,
	): Implementation<Awaited<R>, ImplementationMetaOf<M, {}, EffectiveScope<{}, never>>>
	<
		const D extends Deps,
		R extends SlotValue<T, M> | PromiseLike<SlotValue<T, M>>,
		Sc extends AnyScope = never,
	>(
		deps: D & CheckScopes<D> & DeclaredNames<D>,
		factory: (deps: Resolved<D>, ctx: ServiceContext) => R,
		options?: ServiceOptions<D, Sc>,
	): Implementation<Awaited<R>, ImplementationMetaOf<M, D, EffectiveScope<D, ExplicitScope<Sc>>>>
}

/**
 * `Slot.implementAs()`: a named service that fills the slot, for when
 * something refers to the implementation itself: depends on it, provides,
 * resolves or overrides it. Otherwise it's checked like {@link SlotImplement},
 * with the same rule on options.
 */
export interface SlotImplementAs<T, M extends SlotMeta> {
	<N extends string, R extends SlotValue<T, M> | PromiseLike<SlotValue<T, M>>>(
		name: LiteralName<N>,
		factory: (ctx: ServiceContext) => R,
	): Service<Awaited<R>, ComputeMeta<N, {}, EffectiveScope<{}, never>>>
	<
		N extends string,
		const D extends Deps,
		R extends SlotValue<T, M> | PromiseLike<SlotValue<T, M>>,
		Sc extends AnyScope = never,
	>(
		name: LiteralName<N>,
		deps: D & CheckScopes<D> & DeclaredNames<D>,
		factory: (deps: Resolved<D>, ctx: ServiceContext) => R,
		options?: ServiceOptions<D, Sc>,
	): Service<Awaited<R>, ComputeMeta<N, D, EffectiveScope<D, ExplicitScope<Sc>>>>
}

/**
 * Declare a service. Its dependencies are values, so its requirements and
 * scope are inferred; one instance exists per container of its scope.
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
	return declareService(name, rest, undefined)
}

/** What `service()`, `Slot.implement()` and `Slot.implementAs()` share; `slot` is the slot implemented, if any. */
export function declareService(
	name: string,
	rest: unknown[],
	slot: unknown,
	anonymous = false,
): unknown {
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
			assertDistinctNames(scope, inferred, `Service '${name}'`)
			throw new DowelError(
				'CAPTIVE_DEPENDENCY',
				`Service '${name}' depends on '${key}' in scope '${scope.name}' and on another dependency in scope '${inferred.name}', which are on different scope branches.`,
			)
		}
		inferred = next
	}

	const explicit = options?.scope === undefined ? null : scopeNode(options.scope)
	if (explicit !== null && !isAtOrAbove(inferred, explicit)) {
		assertDistinctNames(explicit, inferred, `Service '${name}'`)
		throw new DowelError(
			'CAPTIVE_DEPENDENCY',
			deeper(inferred, explicit) === null
				? `Service '${name}' is declared in scope '${explicit.name}' but a dependency lives in '${inferred.name}', which is on a different scope branch.`
				: `Service '${name}' is declared in scope '${explicit.name}' but a dependency lives in '${inferred.name}', below it.`,
		)
	}
	const scope = explicit ?? inferred

	let implemented: SlotNode | null = null
	if (slot !== undefined) {
		try {
			implemented = slotNode(slot)
		} catch (cause) {
			throw new DowelError('INVALID_NODE', `What '${name}' implements is not a slot.`, { cause })
		}
	}

	const node: ServiceNode = {
		kind: 'service',
		id: allocateId(),
		name,
		scope,
		// Copied, so changing the object afterwards cannot change the graph its scope was checked against.
		deps: Object.freeze({ ...deps }),
		factory,
		implements: implemented,
		anonymous,
	}
	return Object.freeze({
		'~kind': 'service',
		name,
		scope: scope.name,
		[internal]: node,
	}) as Service<unknown, any>
}
