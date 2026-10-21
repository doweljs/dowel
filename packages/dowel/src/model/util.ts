/** General-purpose type helpers. */

export type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
	x: infer I,
) => void
	? I
	: never

/**
 * Whether `S` is exactly one string literal: not `string`, not a pattern
 * such as `job-${string}`, not a union and not `never`.
 */
export type IsSingleLiteral<S extends string> = [S] extends [never]
	? false
	: {} extends Record<S, true>
		? false
		: [S] extends [UnionToIntersection<S>]
			? true
			: false

/** Flattens intersections and mapped types into a readable object type. */
export type Simplify<T> = { [K in keyof T]: T[K] } & {}
