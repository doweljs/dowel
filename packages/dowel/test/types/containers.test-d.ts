/**
 * Type-level tests, checked by `tsc` and never executed: many of the calls
 * below are deliberately invalid and would throw at runtime.
 */
import { expectTypeOf } from 'bun:test'
import { bind, type Container, container, service } from '../../src/index.ts'
import {
	Config,
	CurrentUser,
	Logger,
	type LoggerApi,
	PerRequest,
	Request,
	Session,
	test,
	Users,
} from './support.ts'

test('get is checked against what the container holds', async () => {
	const app = await container()
		.provide(CurrentUser)
		.bind(Logger, { info() {} })
		.build()

	expectTypeOf(app.get(Users).list).toEqualTypeOf<() => string[]>()
	expectTypeOf(app.get(Config)).toEqualTypeOf<{ dbUrl: string }>()
	expectTypeOf(app.get(Logger)).toEqualTypeOf<LoggerApi>()

	const Mailer = service('Mailer', () => ({ send() {} }))
	// @ts-expect-error: never provided
	app.get(Mailer)
	// @ts-expect-error: a request-scoped service from the root container
	app.get(CurrentUser)
	// @ts-expect-error: scoped slot from root
	app.get(Request)

	// @ts-expect-error: Request value is required
	app.open(PerRequest)
	// @ts-expect-error: wrong value type
	app.open(PerRequest, bind(Request, 1))
	const reqBinding = bind(
		Request,
		service('ReqSvc', () => ({ url: '/' })),
	)
	// @ts-expect-error: scope bindings carry values, not services
	app.open(reqBinding)
	const s = await app.open(PerRequest, bind(Request, { url: '/' }))
	expectTypeOf(s).toMatchTypeOf<Container<any, any>>()
	expectTypeOf(s.get(CurrentUser).req).toEqualTypeOf<{ url: string }>()
	expectTypeOf(s.get(Request)).toEqualTypeOf<{ url: string }>()
	expectTypeOf(s.get(Users).list).toEqualTypeOf<() => string[]>()
	// @ts-expect-error: Session is not in the graph
	s.get(Session)
})
