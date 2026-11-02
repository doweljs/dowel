/**
 * Type-level tests, checked by `tsc` and never executed: many of the calls
 * below are deliberately invalid and would throw at runtime.
 */
import { expectTypeOf } from 'bun:test'
import {
	type Container,
	container,
	type ReservedScopeName,
	scope,
	service,
	slot,
	type UntypedScopeBindings,
} from '../../src/index.ts'
import type { ScopeName } from '../../src/model/checks.ts'
import type { MetaOf } from '../../src/model/infer.ts'
import type { OpenCheck } from '../../src/model/state.ts'
import { Logger, test, Users } from './support.ts'

test('a container remembers the optional slots it was opened with', async () => {
	const PerVisit = scope('visit')
	const Visitor = slot('Visitor', { scope: PerVisit })<{ id: string }>()
	const Greeting = service(
		'Greeting',
		{ visitor: Visitor.optional() },
		({ visitor }) => visitor?.id,
	)
	const app = await container().provide(Greeting).build()
	const anonymous = await app.open(PerVisit)
	expectTypeOf(anonymous.get(Visitor)).toEqualTypeOf<{ id: string } | undefined>()
	const known = await app.open(PerVisit, Visitor.of({ id: 'v' }))
	expectTypeOf(known.get(Visitor)).toEqualTypeOf<{ id: string }>()
})

test('nested scopes', () => {
	const SessionScope = scope('session')
	const RequestScope = scope('request', SessionScope)
	const JobScope = scope('job')
	const reserved = () => {
		expectTypeOf<ScopeName<'root'>>().toEqualTypeOf<ReservedScopeName<'root'>>()
		// @ts-expect-error: the container's own scope name is reserved
		scope('root', SessionScope)
	}
	void reserved
	const Sess = slot('Sess', { scope: SessionScope })<{ id: string }>()
	const Req = slot('Req', { scope: RequestScope })<{ url: string }>()
	const Job = slot('Job', { scope: JobScope })<{ name: string }>()

	// The deepest dependency decides the scope.
	const Handler = service('Handler', { sess: Sess, req: Req, users: Users }, (d) => d)
	expectTypeOf(Handler.scope).toEqualTypeOf<'request'>()
	expectTypeOf<MetaOf<typeof Handler>['above']>().toEqualTypeOf<'root' | 'session'>()

	// Dependencies on different branches are rejected.
	// @ts-expect-error: request and job are on different branches
	service('Mixed', { req: Req, job: Job }, (d) => d)
	// @ts-expect-error: a union-valued dependency may also cross scope branches
	service('EitherBranch', { either: Math.random() > 0.5 ? Req : Job }, (d) => d)

	// An explicit scope may be deeper than the dependencies imply, never shallower.
	const Uow = service('Uow', { users: Users }, (d) => d, { scope: RequestScope })
	expectTypeOf(Uow.scope).toEqualTypeOf<'request'>()
	// @ts-expect-error: session is above the request-scope dependency
	service('TooShallow', { req: Req }, (d) => d, { scope: SessionScope })

	// Bindings must live at or above the slot.
	const ReqImpl = service('ReqImpl', { sess: Sess }, () => ({ url: '/' }))
	Req.of(ReqImpl)
	const SessImpl = service('SessImpl', { req: Req }, () => ({ id: '1' }))
	// @ts-expect-error: a request-scope service cannot implement a session-scope slot
	Sess.of(SessImpl)

	const app = container()
		.provide(Handler)
		.bind(Logger, { info() {} })
		.build()
	expectTypeOf(app).resolves.toMatchTypeOf<Container<any>>()
	void (async () => {
		const built = await app
		const sessionScope = await built.open(SessionScope, Sess.of({ id: 's' }))
		expectTypeOf(sessionScope).toMatchTypeOf<Container<any, any>>()
		const requestScope = await sessionScope.open(RequestScope, Req.of({ url: '/' }))
		expectTypeOf(requestScope.get(Handler).req.url).toEqualTypeOf<string>()
		expectTypeOf(requestScope.get(Sess).id).toEqualTypeOf<string>()
		// @ts-expect-error: request-scope nodes are not visible from a session scope
		sessionScope.get(Handler)
		// @ts-expect-error: request is not a child of root
		built.open(RequestScope, Req.of({ url: '/' }))
		// @ts-expect-error: the session value is required
		built.open(SessionScope)
	})()
})

test('open() names a binding typed any, such as one made by a failed import, instead of misreading it', async () => {
	const PerVisit = scope('visit')
	const Visitor = slot('Visitor', { scope: PerVisit })<{ id: string }>()
	const Greeting = service('Greeting', { visitor: Visitor }, ({ visitor }) => visitor.id)
	const app = await container().provide(Greeting).build()
	type State = typeof app extends Container<infer S, any, any> ? S : never
	const loose: any = Visitor.of({ id: 'v' })

	// @ts-expect-error: the binding is any
	app.open(PerVisit, loose)
	// @ts-expect-error: the second binding is any
	app.open(PerVisit, Visitor.of({ id: 'v' }), loose)
	expectTypeOf<OpenCheck<State, 'visit', [any]>>().toEqualTypeOf<UntypedScopeBindings<'0'>>()
	expectTypeOf<
		OpenCheck<State, 'visit', [typeof Visitor.of extends (v: any) => infer B ? B : never, any]>
	>().toEqualTypeOf<UntypedScopeBindings<'1'>>()
})
