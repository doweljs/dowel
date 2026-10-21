/**
 * Checks on what declarations are given. A diagnostic takes the place of a
 * parameter's or result's type when the check fails; a parameter check is
 * `unknown` when it passes, so intersecting it leaves valid calls untouched.
 */

import type { AnyScope } from './declarations.ts'
import type { IndefiniteName, IndefiniteScope } from './diagnostics.ts'
import type { MetaOf } from './infer.ts'
import type { IsSingleLiteral } from './util.ts'

/**
 * `T` when `N` is one literal name, or else a diagnostic in its place. Nodes
 * are identified by name, so a widened name would let the types mistake one
 * node for another. Checked on the result rather than on the name, so a
 * helper generic in the name (`<N extends string>(name: N) => service(name, …)`)
 * still compiles and is checked at each of its call sites.
 */
export type Named<N extends string, T> = IsSingleLiteral<N> extends true ? T : IndefiniteName<N>

/**
 * `unknown` when `Sc` is one particular declared scope. Every API that takes
 * a scope (slot and service options, executions, a scope's parent, `open()`)
 * checks it with this: a widened or union scope gives the types no single
 * lifetime to check, so a captive dependency would compile.
 */
export type DeclaredScope<Sc extends AnyScope> =
	IsSingleLiteral<MetaOf<Sc>['name']> extends true ? unknown : IndefiniteScope<MetaOf<Sc>['name']>
