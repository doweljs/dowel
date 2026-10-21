/**
 * Type-level tests, checked by `tsc` and never executed: many of the calls
 * below are deliberately invalid and would throw at runtime.
 */
import { expectTypeOf } from 'bun:test'
import { bind, container, execution, scope, service, slot } from '../../src/index.ts'
import { Config, Logger, PerRequest, Request, test, Users } from './support.ts'

test('the types reject what build() and open() reject at runtime', async () => {
	// A slot provided as a root is required.
	// @ts-expect-error: Logger is provided but never bound
	container().provide(Logger).build()

	// An override wins over a later binding or contribution, as at runtime.
	const Clock = slot('Clock')<{ now(): number }>()
	const Middleware = slot('Middleware', { many: true })<(input: string) => string>()
	// An override replaces the whole set.
	const NeedsClock = service('NeedsClock', { clock: Clock }, ({ clock }) => [
		(s: string) => `${s}${clock.now()}`,
	])
	const Server = service('Server', { middleware: Middleware }, ({ middleware }) => middleware)
	container()
		.contribute(Middleware, (s) => s)
		.override(Middleware, NeedsClock)
		.provide(Server)
		// @ts-expect-error: the override still needs Clock after Server is provided
		.build()
	container()
		.provide(Server)
		.contribute(Middleware, (s) => s)
		.override(Middleware, NeedsClock)
		.contribute(Middleware, (s) => s)
		// @ts-expect-error: a later contribution does not undo the override, which needs Clock
		.build()

	// Only a bound slot can be overridden.
	container()
		.provide(Users)
		.override(Logger, { info() {} })
		// @ts-expect-error: Logger is not bound
		.build()

	// An array of unknown length may hold any subset of its elements, so it is rejected.
	const services = [Users, Config]
	// @ts-expect-error: not a tuple
	container().provide(...services)
	container().provide(...([Users, Config] as const))

	// Executions: an input cannot also be bound at build().
	const JobScope = scope('job')
	const In = slot('In', { scope: JobScope })<string>()
	const Job = execution('Job', { scope: JobScope, entry: In, inputs: { input: In } })
	// @ts-expect-error: In is supplied by each run
	container().provide(Job).bind(In, 'x').build()

	// Scopes cannot supply other scopes' slots, build-time bindings or multi-bindings.
	const Scoped = service('Scoped', { req: Request, log: Logger }, (d) => d)
	const Items = slot('Items', { scope: JobScope, many: true })<number>()
	const ItemUser = service('ItemUser', { items: Items }, (d) => d)
	const app = await container()
		.provide(Scoped, ItemUser)
		.bind(Logger, { info() {} })
		.build()
	// @ts-expect-error: In lives in 'job'
	app.open(PerRequest, bind(Request, { url: '/' }), bind(In, 'x'))
	// @ts-expect-error: Logger is bound at build()
	app.open(PerRequest, bind(Request, { url: '/' }), bind(Logger, { info() {} }))
	// @ts-expect-error: a multi-binding
	app.open(JobScope, bind(Items, 1))

	// A detached build is still the method.
	const { build } = container().provide(Config)
	expectTypeOf(build).toBeFunction()
})
