/**
 * Scope inference: where a service lives, given its dependencies and an
 * optional explicit scope. A scope is described by its name and the names
 * of every scope above it.
 */

import type { Deps, Optional, Placement, RootMeta } from './declarations.ts'
import type { IncomparableScopes } from './diagnostics.ts'

/** The scope a dependency puts its dependent at: its own placement. */
export type ScopeOf<D> =
	D extends Optional<infer G>
		? ScopeOf<G>
		: D extends { readonly '~meta'?: infer M extends Placement }
			? { readonly name: M['scope']; readonly above: M['above'] }
			: never

/** A scope as inference sees it: a name and its ancestors, without the parent a declared scope has. */
export interface ScopeDescriptor {
	readonly name: string
	readonly above: string
}

/**
 * The deepest of a set of scopes: the one every other is an ancestor of.
 * `never` when the scopes are on different branches.
 */
export type Deepest<Ls extends ScopeDescriptor> = [Ls] extends [never]
	? RootMeta
	: DeepestOf<Ls, Ls>

/**
 * Distributes over `X` while keeping the whole set `All` in view. Its own name
 * is allowed, so there is no need to structurally exclude `X` from `All` first.
 */
type DeepestOf<X extends ScopeDescriptor, All extends ScopeDescriptor> = X extends ScopeDescriptor
	? All['name'] extends X['above'] | X['name']
		? X
		: never
	: never

// Form a union of scope descriptors, without first comparing whole dependencies.
// Optional keys must not add undefined to that union.
type DependencyScopes<D extends Deps> = { [K in keyof D]-?: ScopeOf<D[K]> }[keyof D]

/** The scope a service's dependencies put it at, before any explicit option. */
export type InferredScope<D extends Deps> = Deepest<DependencyScopes<D>>

export type CheckScopes<D extends Deps> = [InferredScope<D>] extends [never]
	? IncomparableScopes<DependencyScopes<D>['name']>
	: unknown

/** The scope a service ends up at: the explicit one, or the deepest dependency's. */
export type EffectiveScope<D extends Deps, Explicit> = [Explicit] extends [never]
	? InferredScope<D>
	: Explicit extends ScopeDescriptor
		? Explicit
		: never
