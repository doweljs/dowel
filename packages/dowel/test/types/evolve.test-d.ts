/**
 * Type-level tests of `@doweljs/core/evolve`, checked by `tsc` and never
 * executed.
 */
import { expectTypeOf } from 'bun:test'
import {
	type Activation,
	type Candidate,
	hot,
	type LineageSnapshot,
	prepare,
	snapshot,
} from '../../src/evolve.ts'
import {
	type ActiveContext,
	type Container,
	container,
	type RunContext,
	type ServiceContext,
	service,
} from '../../src/index.ts'
import { Logger, test, Users } from './support.ts'

declare const previous: Container<any>

test('prepare() takes a builder that can build, and types its candidate from it', async () => {
	const builder = container().provide(Users).bind(Logger, console)
	const candidate = await prepare(previous, builder)
	expectTypeOf(candidate).toMatchTypeOf<Candidate<any>>()
	expectTypeOf(candidate.container.get(Users).list()).toEqualTypeOf<string[]>()
	const activation = await candidate.activate({ drain: 1000 })
	expectTypeOf(activation).toMatchTypeOf<Activation<any>>()
	expectTypeOf(activation.generation).toEqualTypeOf<number>()
	expectTypeOf(activation.retired).toEqualTypeOf<Promise<void>>()
	expectTypeOf(activation.container.get(Users).list()).toEqualTypeOf<string[]>()

	// @ts-expect-error: Logger is not bound, so the builder cannot build
	await prepare(previous, container().provide(Users))
	// @ts-expect-error: a container, not a builder
	await prepare(previous, previous)
})

test('hot() types the container from the builder, and refuses one that cannot build', async () => {
	const app = await hot(undefined, container().provide(Users).bind(Logger, console))
	expectTypeOf(app.get(Users).list()).toEqualTypeOf<string[]>()
	await hot(globalThis, container().provide(Users).bind(Logger, console), { name: 'app', drain: 0 })
	// @ts-expect-error: Logger is not bound
	await hot({}, container().provide(Users))
	expectTypeOf(snapshot()).toEqualTypeOf<LineageSnapshot[]>()
})

test('effects receive what was handed over as unknown, and the generation they start in', () => {
	service('Port', (ctx) => {
		expectTypeOf(ctx).toEqualTypeOf<ServiceContext>()
		ctx.whileActive((previous, active) => {
			expectTypeOf(previous).toBeUnknown()
			expectTypeOf(active).toEqualTypeOf<ActiveContext>()
			return () => ({ socket: 1 })
		})
		ctx.whileActive(async () => {})
		ctx.whileActive(() => {})
		// @ts-expect-error: a stop function, nothing else
		ctx.whileActive(() => 1)
	})
})

test('runs and containers tell when they were superseded', () => {
	expectTypeOf<RunContext['superseded']>().toEqualTypeOf<AbortSignal>()
	expectTypeOf<Container['superseded']>().toEqualTypeOf<AbortSignal>()
})
