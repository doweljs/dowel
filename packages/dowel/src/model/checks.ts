/**
 * Checks on what declarations are given. A diagnostic takes the place of a
 * parameter's type when the check fails; a check intersected with a
 * parameter is `unknown` when it passes, so it leaves valid calls untouched.
 */

import type { AnyScope } from './declarations.ts'
import type { IndefiniteName, IndefiniteScope, ReservedScopeName } from './diagnostics.ts'
import type { Graph } from './graph.ts'
import type { MetaOf } from './infer.ts'
import type { IsSingleLiteral } from './util.ts'

/**
 * Whether the types can tell a name apart from every other: `literal` for
 * one string literal, `wide` for `string`, a pattern, a union or `never`,
 * and `reserved` for a literal in `Reserved`. Nodes are identified by name,
 * so a wide name would let the types mistake one node for another.
 *
 * While the name is a type parameter, as in a helper generic in the name
 * (`<N extends string>(name: N) => service(`${name}.a`, …)`), the status is
 * undecided. TypeScript still accepts an argument for a parameter checked
 * against it when no instantiation could fail the check, which it judges by
 * putting a wildcard in place of each type parameter. The wildcard is
 * extended by `unknown`, which no name is, and extends `never`, which `any`
 * does not, so it is `generic`. The helper then compiles, and what it
 * declares is checked where it is used.
 *
 * An `any` name is `Any`: `wide` by default, since it would make every
 * graph it joins match any name. A declaration's own name parameter passes
 * `generic`, as an `any` argument fits whatever it is checked against. The
 * `unknown` read from an `any` node's name, which is why `N` is
 * unconstrained, is `generic`: such a node opts out, as `any` does elsewhere.
 */
type NameStatus<N, Reserved extends string = never, Any extends 'generic' | 'wide' = 'wide'> = [
	unknown,
] extends [N]
	? [N] extends [never]
		? 'generic'
		: 0 extends 1 & N
			? Any
			: 'generic'
	: IsSingleLiteral<N & string> extends true
		? [N] extends [Reserved]
			? 'reserved'
			: 'literal'
		: 'wide'

/** The type of a declaration's name: `N` when it is one literal or still generic, or else a diagnostic. */
export type LiteralName<N extends string> =
	NameStatus<N, never, 'generic'> extends 'wide' ? IndefiniteName<N> : N

/** {@link LiteralName} for a scope, which also may not take the container's own name, `root`. */
export type ScopeName<N extends string> =
	NameStatus<N, 'root', 'generic'> extends 'wide'
		? IndefiniteName<N>
		: NameStatus<N, 'root', 'generic'> extends 'reserved'
			? ReservedScopeName<N>
			: N

/**
 * The status of each name in `X`: a node's, or in `optional()` its slot's;
 * `undefined` from an optional key has none. Matched on the `name` property
 * alone: matching whole dependency types against their metadata, against
 * `Optional<…>` or to rule out `any` would cost far more.
 *
 * A node that is itself a type parameter, as in a helper generic in the
 * node (`<S extends AnyService>(s: S) => service('wrap', { s }, …)`), has
 * no status while it is generic: the wildcard put in its place extends
 * `never`, which no node does. Its name is checked where the helper's
 * result is used.
 */
type StatusOf<X> = [X] extends [never]
	? never
	: X extends { readonly name: infer Name }
		? NameStatus<Name>
		: X extends { readonly '~kind': 'optional'; readonly slot: infer G }
			? StatusOf<G>
			: X extends Bound<infer Name>
				? NameStatus<Name>
				: never

type WideNames<X> = X extends { readonly name: infer Name } | Bound<infer Name>
	? NameStatus<Name> extends 'wide'
		? Name & string
		: never
	: X extends { readonly '~kind': 'optional'; readonly slot: infer G }
		? WideNames<G>
		: never

/** A binding of the slot `Name`, read from its metadata: its `slot` is typed as any slot. */
type Bound<Name> = { readonly '~kind': 'binding'; readonly '~meta'?: { readonly name: Name } }

/**
 * `unknown` when the node `X` (or each in a union) has a name
 * {@link LiteralName} accepts. APIs that take nodes check them with this or
 * {@link DeclaredNames}, which catches a wide name that a helper generic in
 * the name passed on.
 */
export type DeclaredName<X> = 'wide' extends StatusOf<X> ? IndefiniteName<WideNames<X>> : unknown

/**
 * {@link DeclaredName} for each node in `D`, such as a service's
 * dependencies. Checked key by key, so the checker never has to compare
 * whole dependency types to form their union. A record that is itself a
 * type parameter has no status while it is generic, like such a node.
 */
export type DeclaredNames<D> =
	'wide' extends Statuses<D>
		? IndefiniteName<{ [K in keyof D]-?: WideNames<D[K]> }[keyof D]>
		: unknown

type Statuses<D> = [D] extends [never] ? never : { [K in keyof D]-?: StatusOf<D[K]> }[keyof D]

/**
 * A builder issue when {@link LiteralName} would reject the name `N`. The
 * builder records these, like its other composition problems, rather than
 * checking each parameter: a check on an implementation would keep a
 * function passed there from being inferred.
 */
export type IndefiniteNameIssue<N extends string> =
	NameStatus<N> extends 'wide'
		? `'${N}' is not one literal name; name each declaration with one string literal`
		: never

/**
 * Each of `Names` that is `string` or a pattern rather than a literal.
 * Unlike {@link NameStatus}, it takes a union as several names, which is
 * how a graph lists them.
 */
type Patterns<Names> = Names extends string
	? {} extends Record<Names, true>
		? Names
		: never
	: never

/**
 * Builder issues for the names in a graph the types cannot tell apart: a
 * node's, or a scope's it places a node in. A helper generic in a name can
 * hide one inside what it declares, past every check on what it was given,
 * such as a literal-named service depending on a node it named. A union
 * name reads as several nodes here, so only those checks can catch it.
 */
export type IndefiniteGraphIssues<G extends Graph> =
	| IndefiniteNameIssue<Patterns<keyof G>>
	| `scope '${Patterns<G[keyof G]['scope' | 'above' | 'child']>}' is not one literal name; name each scope with one string literal`

/**
 * `unknown` when `Sc` is one particular declared scope. Every API that takes
 * a scope (slot and service options, executions, a scope's parent, `open()`)
 * checks it with this: a widened or union scope gives the types no single
 * lifetime to check, so a captive dependency would compile. A scope named
 * `root`, which {@link ScopeName} lets through while a helper's name is
 * generic, is rejected here too, as is a scope below one the types cannot
 * pin down, which a helper generic in the name can declare.
 */
export type DeclaredScope<Sc extends AnyScope> =
	NameStatus<MetaOf<Sc>['name'], 'root'> extends 'wide'
		? IndefiniteScope<MetaOf<Sc>['name']>
		: NameStatus<MetaOf<Sc>['name'], 'root'> extends 'reserved'
			? ReservedScopeName<'root'>
			: 'wide' extends EachStatus<MetaOf<Sc>['above']>
				? IndefiniteScope<WideEach<MetaOf<Sc>['above']>>
				: unknown

/** The status of each name in the union `Names`, such as a scope's ancestors; none while it is generic. */
type EachStatus<Names> = [Names] extends [never]
	? never
	: Names extends unknown
		? NameStatus<Names>
		: never

type WideEach<Names> = Names extends unknown
	? NameStatus<Names> extends 'wide'
		? Names & string
		: never
	: never
