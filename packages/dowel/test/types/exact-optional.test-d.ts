/**
 * Type-level tests that need exactOptionalPropertyTypes: a dependency or
 * input map whose keys may be absent, such as `cond ? { input: Input } : {}`.
 * Without the option, TypeScript reads the absent key as `input?: undefined`,
 * and `undefined` isn't a node, so `tsconfig.loose.json` leaves this file out.
 */
import { expectTypeOf } from 'bun:test'
import { container, execution, type Infer, scope, service, slot } from '../../src/index.ts'
import type { MetaOf } from '../../src/model/infer.ts'
import { test } from './support.ts'

test('conditionally present dependency keys retain their scopes and requirements', () => {
	const Input = slot('ConditionalInput')<number>()
	const deps = Math.random() > 0.5 ? { input: Input } : {}
	const Consumer = service('Consumer', deps, ({ input }) => ({ input }))

	expectTypeOf(Consumer.scope).toEqualTypeOf<'root'>()
	expectTypeOf<Infer<typeof Consumer>>().toEqualTypeOf<{ input: number | undefined }>()
	expectTypeOf<keyof MetaOf<typeof Consumer>['graph']>().toEqualTypeOf<
		'Consumer' | 'ConditionalInput'
	>()
	// @ts-expect-error: the branch with Input still requires a binding
	container().provide(Consumer).build()
	container().provide(Consumer).bind(Input, 1).build()

	// An explicitly optional property must behave like the inferred union above.
	const make = (deps: { input?: typeof Input }) =>
		service('Annotated', deps, ({ input }) => ({ input }))
	const Annotated = make({})
	expectTypeOf(Annotated.scope).toEqualTypeOf<'root'>()
	expectTypeOf<Infer<typeof Annotated>>().toEqualTypeOf<{ input: number | undefined }>()
	expectTypeOf<keyof MetaOf<typeof Annotated>['graph']>().toEqualTypeOf<
		'Annotated' | 'ConditionalInput'
	>()
	// @ts-expect-error: the helper's declared dependency map may contain Input
	container().provide(Annotated).build()
	container().provide(Annotated).bind(Input, 1).build()
})

test('conditionally present execution inputs preserve the graph and runner types', async () => {
	const Job = scope('job')
	const Input = slot('ConditionalInput', { scope: Job })<number>()
	const Entry = service('Entry', () => 1)
	const inputs = Math.random() > 0.5 ? { input: Input } : {}
	const Run = execution('Run', { scope: Job, entry: Entry, inputs })

	expectTypeOf<keyof MetaOf<typeof Run>['graph']>().toEqualTypeOf<
		'Run' | 'Entry' | 'ConditionalInput'
	>()
	const app = await container().provide(Run).build()
	expectTypeOf(app.get(Run)({}, (entry) => entry)).toEqualTypeOf<Promise<number>>()
	// @ts-expect-error: an input supplied by a run cannot also be bound at build()
	container().provide(Run).bind(Input, 1).build()

	const make = (inputs: { input?: typeof Input }) =>
		execution('Annotated', { scope: Job, entry: Entry, inputs })
	const Annotated = make({})
	expectTypeOf<keyof MetaOf<typeof Annotated>['graph']>().toEqualTypeOf<
		'Annotated' | 'Entry' | 'ConditionalInput'
	>()
	const annotated = await container().provide(Annotated).build()
	expectTypeOf(annotated.get(Annotated)({}, (entry) => entry)).toEqualTypeOf<Promise<number>>()
})
