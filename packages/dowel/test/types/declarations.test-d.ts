/**
 * Type-level tests, checked by `tsc` and never executed: many of the calls
 * below are deliberately invalid and would throw at runtime.
 */
import { expectTypeOf } from 'bun:test'
import type { Container } from '../../src/api.ts'
import type { ServiceOptions } from '../../src/declare/service.ts'
import {
	bind,
	container,
	execution,
	type Infer,
	optional,
	type Slot,
	scope,
	service,
	slot,
} from '../../src/index.ts'
import type { DeclaredScope, LiteralName } from '../../src/model/checks.ts'
import type { AnyScope, AnyService } from '../../src/model/declarations.ts'
import type {
	CompositionIssues,
	EmptySlotOptions,
	EntryNotVisible,
	IndefiniteName,
	IndefiniteScope,
	MaybeMany,
	MaybeMissingScope,
} from '../../src/model/diagnostics.ts'
import type { MetaOf } from '../../src/model/infer.ts'
import type { IsSingleLiteral } from '../../src/model/util.ts'
import {
	Config,
	type CurrentUser,
	type Db,
	Logger,
	type LoggerApi,
	PerRequest,
	Request,
	Session,
	test,
	Users,
} from './support.ts'

test('only one declared scope counts as a scope', () => {
	const Job = scope('job')
	expectTypeOf<DeclaredScope<typeof PerRequest>>().toEqualTypeOf<unknown>()
	expectTypeOf<DeclaredScope<AnyScope>>().toEqualTypeOf<IndefiniteScope<string>>()
	expectTypeOf<DeclaredScope<typeof PerRequest | typeof Job>>().toEqualTypeOf<
		IndefiniteScope<'request' | 'job'>
	>()
	expectTypeOf<IsSingleLiteral<`job-${string}`>>().toEqualTypeOf<false>()
	expectTypeOf<IsSingleLiteral<never>>().toEqualTypeOf<false>()
})

test('every API that takes a scope rejects one the types cannot pin down', () => {
	type Wide = AnyScope
	type Rejects<P> = [NonNullable<P>] extends [IndefiniteScope<string>] ? true : false
	// Each parameter that takes a scope carries the diagnostic itself, so these
	// fail if a call site stops checking, not merely if some other check fails.
	expectTypeOf<
		Rejects<Parameters<typeof slot<'S', { readonly scope: Wide }>>[1]>
	>().toEqualTypeOf<true>()
	expectTypeOf<Rejects<ServiceOptions<{}, Wide>['scope']>>().toEqualTypeOf<true>()
	expectTypeOf<
		Rejects<Parameters<typeof execution<'E', Wide, typeof Users>>[1]['scope']>
	>().toEqualTypeOf<true>()
	expectTypeOf<Rejects<Parameters<typeof scope<'child', Wide>>[1]>>().toEqualTypeOf<true>()
	expectTypeOf<Rejects<Parameters<Container['open']>[0]>>().toEqualTypeOf<true>()
	expectTypeOf<
		Rejects<Parameters<typeof slot<'S', { readonly scope?: typeof PerRequest }>>[1]>
	>().toEqualTypeOf<false>()
	expectTypeOf<Parameters<typeof slot<'S', { readonly scope?: typeof PerRequest }>>[1]>().toExtend<
		MaybeMissingScope<'S'>
	>()

	const Job = scope('job')
	const either = Math.random() > 0.5 ? PerRequest : Job
	const flag = Math.random() > 0.5
	// Asserted, not annotated: an annotated const narrows to what it was assigned.
	const maybeScope = null! as { scope?: typeof PerRequest }
	const maybeMany = null! as { many?: true }
	const empty = null! as {}
	const maybeOptions = null! as { scope: typeof PerRequest } | undefined
	// @ts-expect-error: a union of scopes
	slot('Either', { scope: either })
	// @ts-expect-error: the scope may be missing
	slot('MaybeScope', maybeScope)
	// @ts-expect-error: many must be true, not a boolean
	slot('Flag', { many: flag })
	// @ts-expect-error: many may be missing
	slot('MaybeMany', maybeMany)
	// @ts-expect-error: many in only one branch
	slot('Branch', flag ? { many: true } : {})
	// @ts-expect-error: options typed {} may hold either option
	slot('Empty', empty)
	// @ts-expect-error: options that may be undefined, so the slot may be root
	slot('MaybeOptions', maybeOptions)
	expectTypeOf<Parameters<typeof slot<'S', { readonly many?: true }>>[1]>().toExtend<
		MaybeMany<'S'>
	>()
	expectTypeOf<Parameters<typeof slot<'S', {}>>[1]>().toExtend<EmptySlotOptions<'S'>>()

	const saved = { scope: PerRequest }
	expectTypeOf(slot('Saved', saved)<number>().scope).toEqualTypeOf<'request'>()
	expectTypeOf(slot('Items', { many: true })<number>()).toExtend<Slot<readonly number[], any>>()
})

test('declarations need one literal name', () => {
	expectTypeOf<LiteralName<'A'>>().toEqualTypeOf<'A'>()
	expectTypeOf<LiteralName<string>>().toEqualTypeOf<IndefiniteName<string>>()
	expectTypeOf<LiteralName<'A' | 'B'>>().toEqualTypeOf<IndefiniteName<'A' | 'B'>>()
	expectTypeOf<LiteralName<`job-${string}`>>().toEqualTypeOf<IndefiniteName<`job-${string}`>>()
	const wide = 'A' as string
	// @ts-expect-error: a widened service name
	service(wide, () => 1)
	// @ts-expect-error: a widened slot name
	slot(wide)
	// @ts-expect-error: a widened scope name
	scope(wide)
	// @ts-expect-error: a widened execution name
	execution(wide, { scope: PerRequest, entry: Request })
	// @ts-expect-error: a union
	service('A' as 'A' | 'B', () => 1)

	// An `any` argument fits any parameter, so an `any` name is caught where the node is used.
	const anyName = null! as any
	const ByAny = service(anyName, () => 1)
	const ScopeByAny = scope(anyName)
	// @ts-expect-error: as a dependency
	service('UsesAny', { byAny: ByAny }, ({ byAny }) => byAny)
	// @ts-expect-error: as a scope
	slot('InAny', { scope: ScopeByAny })
	expectTypeOf(container().provide(ByAny).build).toEqualTypeOf<
		CompositionIssues<`'${any}' is not one literal name; name each declaration with one string literal`>
	>()
})

test('a helper generic in a node it depends on or supplies compiles', () => {
	const Work = scope('work')
	const Input = slot('Input', { scope: Work })<number>()
	const wrap = <S extends AnyService>(inner: S) => service('Wrap', { inner }, () => 1)
	const fed = <I extends typeof Input>(input: I) =>
		execution('Fed', { scope: Work, entry: Input, inputs: { input } })
	expectTypeOf(wrap(Config).name).toEqualTypeOf<'Wrap'>()
	expectTypeOf(fed(Input).name).toEqualTypeOf<'Fed'>()

	// Or in a whole record of them.
	const multi = <D extends { readonly [key: string]: AnyService }>(deps: D) =>
		service('Multi', deps, () => 1)
	const fedAll = <I extends { readonly input: typeof Input }>(inputs: I) =>
		execution('FedAll', { scope: Work, entry: Input, inputs })
	expectTypeOf(multi({ config: Config }).name).toEqualTypeOf<'Multi'>()
	expectTypeOf(fedAll({ input: Input }).name).toEqualTypeOf<'FedAll'>()
})

test('a helper generic in the name can use what it declares', () => {
	const Work = scope('work')
	const feature = <const Name extends string>(name: Name) => {
		const Input = slot(`${name}.input`, { scope: Work })<number>()
		const Base = service(`${name}.base`, () => 1)
		const Sum = service(
			`${name}.sum`,
			{ base: Base, input: Input, log: optional(Logger) },
			({ base, input }) => base + input,
		)
		const Run = execution(`${name}.run`, { scope: Work, entry: Sum, inputs: { input: Input } })
		const Limit = slot(`${name}.limit`)<number>()
		const Child = scope(`${name}.child`, scope(`${name}.parent`))
		const Scoped = slot(`${name}.scoped`, { scope: Child })<number>()
		const builder = container().provide(Run, bind(Limit, Base)).override(Base, 2)
		return { Input, Base, Run, Limit, Child, Scoped, builder }
	}

	const report = feature('report')
	expectTypeOf(report.Run.name).toEqualTypeOf<'report.run'>()
	expectTypeOf<keyof MetaOf<typeof report.Run>['graph']>().toEqualTypeOf<
		'report.run' | 'report.sum' | 'report.base' | 'report.input' | 'Logger'
	>()
	expectTypeOf(report.Scoped.scope).toEqualTypeOf<'report.child'>()
	void report.builder.build()

	// A widened name passed to the helper is caught where what it declares is used.
	const wide = feature('w' as string)
	// @ts-expect-error: as a dependency
	service('UsesBase', { base: wide.Base }, ({ base }) => base)
	// @ts-expect-error: as an entry
	execution('Reruns', { scope: Work, entry: wide.Base })
	// @ts-expect-error: as an input
	execution('Feeds', { scope: Work, entry: Users, inputs: { input: wide.Input } })
	// @ts-expect-error: as a bound slot
	bind(wide.Limit, 1)
	// @ts-expect-error: as a scope
	slot('InWide', { scope: wide.Child })
	// The builder reports what it is given at build(), as it does other composition problems,
	// together with what that reaches.
	type Issue<Name extends string> =
		`'${Name}' is not one literal name; name each declaration with one string literal`
	type RunGraph = `${string}.run` | `${string}.sum` | `${string}.base` | `${string}.input`
	expectTypeOf(container().provide(wide.Run).build).toEqualTypeOf<
		CompositionIssues<Issue<RunGraph>>
	>()
	expectTypeOf(container().bind(wide.Limit, 1).build).toEqualTypeOf<
		CompositionIssues<Issue<`${string}.limit`>>
	>()
	const logger = <const Name extends string>(name: Name) =>
		service(`${name}.logger`, (): LoggerApi => ({ info() {} }))
	expectTypeOf(container().bind(Logger, logger('w' as string)).build).toEqualTypeOf<
		CompositionIssues<Issue<`${string}.logger`>>
	>()
	expectTypeOf(container().provide(wide.Run).override(wide.Base, 3).build).toEqualTypeOf<
		CompositionIssues<Issue<RunGraph>>
	>()
	// So is a builder the helper made from them.
	expectTypeOf(wide.builder.build).toEqualTypeOf<
		CompositionIssues<Issue<RunGraph | `${string}.limit`>>
	>()

	// A node the helper names literally can still reach one it named from its parameter.
	const wrapped = <const Name extends string>(name: Name) => {
		const Inner = service(`${name}.inner`, () => 1)
		return {
			Outer: service('Outer', { inner: Inner }, ({ inner }) => inner),
			Rerun: execution('Rerun', { scope: Work, entry: Inner }),
		}
	}
	const hidden = wrapped('w' as string)
	expectTypeOf(container().provide(hidden.Outer).build).toEqualTypeOf<
		CompositionIssues<Issue<`${string}.inner`>>
	>()
	expectTypeOf(container().provide(hidden.Rerun).build).toEqualTypeOf<
		CompositionIssues<Issue<`${string}.inner`>>
	>()
	void container().provide(wrapped('literal').Outer).build()

	// So can a helper generic in a scope, given one named from a parameter.
	const inScope = <Sc extends AnyScope>(target: Sc) => slot('InScope', { scope: target })<number>()
	type ScopeIssue<Name extends string> =
		`scope '${Name}' is not one literal name; name each scope with one string literal`
	expectTypeOf(container().provide(inScope(wide.Child)).build).toEqualTypeOf<
		CompositionIssues<ScopeIssue<`${string}.child` | `${string}.parent`>>
	>()
	void container().provide(inScope(report.Child)).build()

	// A binding it makes is checked where it is supplied.
	const supplier = <const Name extends string>(name: Name) => {
		const Supplied = slot(`${name}.supplied`, { scope: Work })<number>()
		return { supply: (value: number) => bind(Supplied, value) }
	}
	const Real = slot('real.supplied', { scope: Work })<number>()
	const opens = async () => {
		const app = await container()
			.provide(service('UsesReal', { real: Real }, ({ real }) => real))
			.build()
		// @ts-expect-error: it would count as supplying 'real.supplied'
		await app.open(Work, supplier('w' as string).supply(1))
		await app.open(Work, bind(Real, 1))
	}
	void opens

	// Nor can a scope below one it named from its parameter.
	const nested = <const Name extends string>(name: Name) => scope('inner', scope(name))
	// @ts-expect-error: its parent may be any scope
	slot('InNested', { scope: nested('w' as string) })
	expectTypeOf(
		slot('InNested', { scope: nested('outer') })<number>().scope,
	).toEqualTypeOf<'inner'>()

	// A scope a helper names `root` cannot be used.
	const named = <const Name extends string>(name: Name) => scope(name)
	// @ts-expect-error: the container's own scope name is reserved
	slot('InRoot', { scope: named('root') })
})

test('executions check their entry and inputs', () => {
	const Job = scope('job')
	const Other = scope('other')
	const Elsewhere = service('Elsewhere', () => 1, { scope: Other })
	// @ts-expect-error: an entry in a scope the runs cannot see
	execution('Run', { scope: Job, entry: Elsewhere })
	expectTypeOf<
		Parameters<typeof execution<'Run', typeof Job, typeof Elsewhere>>[1]['entry']
	>().toExtend<EntryNotVisible<'Elsewhere', 'other'>>()

	const Items = slot('Items', { scope: Job, many: true })<number>()
	// @ts-expect-error: a multi-binding cannot be an input
	execution('Collect', { scope: Job, entry: Items, inputs: { items: Items } })
})

test('slot and service inference', () => {
	expectTypeOf<Infer<typeof Logger>>().toEqualTypeOf<LoggerApi>()
	expectTypeOf(Logger.name).toEqualTypeOf<'Logger'>()
	expectTypeOf(Logger.scope).toEqualTypeOf<'root'>()
	expectTypeOf(Request.scope).toEqualTypeOf<'request'>()

	expectTypeOf<Infer<typeof Db>>().toEqualTypeOf<{ query: (s: string) => string[] }>()
	type DbMeta = MetaOf<typeof Db>
	expectTypeOf<DbMeta['scope']>().toEqualTypeOf<'root'>()
	expectTypeOf<keyof DbMeta['graph']>().toEqualTypeOf<'Db' | 'Config'>()
	expectTypeOf<DbMeta['graph']['Db']['deps']>().toEqualTypeOf<'Config'>()

	type UsersMeta = MetaOf<typeof Users>
	expectTypeOf<keyof UsersMeta['graph']>().toEqualTypeOf<'Users' | 'Db' | 'Config' | 'Logger'>()
	expectTypeOf<UsersMeta['graph']['Logger']['kind']>().toEqualTypeOf<'slot'>()
	expectTypeOf<UsersMeta['graph']['Users']['deps']>().toEqualTypeOf<'Db' | 'Logger'>()

	// Scope propagates from the scoped slot.
	type CurrentMeta = MetaOf<typeof CurrentUser>
	expectTypeOf<CurrentMeta['scope']>().toEqualTypeOf<'request'>()
	expectTypeOf<CurrentMeta['above']>().toEqualTypeOf<'root'>()
	expectTypeOf<CurrentMeta['graph']['Request']['scope']>().toEqualTypeOf<'request'>()
})

test('factory receives resolved dependencies', () => {
	service('Check', { log: Logger, maybe: optional(Session), users: Users }, (deps, ctx) => {
		expectTypeOf(deps.log).toEqualTypeOf<LoggerApi>()
		expectTypeOf(deps.maybe).toEqualTypeOf<{ userId: string } | undefined>()
		expectTypeOf(deps.users.list).toEqualTypeOf<() => string[]>()
		expectTypeOf(ctx.defer).toBeFunction()
		expectTypeOf(ctx.use({ [Symbol.dispose]() {} })).toEqualTypeOf<{ [Symbol.dispose](): void }>()
		expectTypeOf(ctx.adopt(1, () => {})).toEqualTypeOf<number>()
		// @ts-expect-error: not disposable
		ctx.use({})
	})
})

test('required and optional edges', () => {
	const Metrics = slot('Metrics')<number>()
	const Both = service('Both', { a: Metrics, b: optional(Metrics) }, ({ a }) => a)
	expectTypeOf<MetaOf<typeof Both>['graph']['Both']['optional']>().toEqualTypeOf<never>()
	// @ts-expect-error: Metrics is still required
	container().provide(Both).build()
	const Loose = service('Loose', { m: optional(Metrics) }, ({ m }) => m)
	expectTypeOf<MetaOf<typeof Loose>['graph']['Loose']['optional']>().toEqualTypeOf<'Metrics'>()
	container().provide(Loose).build()
})

test('union dependencies retain every possible requirement', () => {
	const LeftInput = slot('LeftInput')<number>()
	const RightInput = slot('RightInput')<number>()
	const Left = service('Left', { input: LeftInput }, ({ input }) => input)
	const Right = service('Right', { input: RightInput }, ({ input }) => input)
	const either = Math.random() > 0.5 ? Left : Right
	const Consumer = service('Consumer', { either }, ({ either }) => either)

	expectTypeOf<keyof MetaOf<typeof Consumer>['graph']>().toEqualTypeOf<
		'Consumer' | 'Left' | 'Right' | 'LeftInput' | 'RightInput'
	>()
	// @ts-expect-error: either branch may require its input
	container().provide(Consumer).build()
	// @ts-expect-error: RightInput is still required by the other branch
	container().provide(Consumer).bind(LeftInput, 1).build()
	// @ts-expect-error: LeftInput is still required by the other branch
	container().provide(Consumer).bind(RightInput, 2).build()
	container().provide(Consumer).bind(LeftInput, 1).bind(RightInput, 2).build()

	const Maybe = service(
		'Maybe',
		{ either: optional(Math.random() > 0.5 ? LeftInput : RightInput) },
		({ either }) => either,
	)
	expectTypeOf<keyof MetaOf<typeof Maybe>['graph']>().toEqualTypeOf<
		'Maybe' | 'LeftInput' | 'RightInput'
	>()
	container().provide(Maybe).build()
})

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

test('bind checks the implementation against the slot', () => {
	bind(Logger, { info: () => {} })
	// @ts-expect-error: wrong shape
	bind(Logger, { warn: () => {} })

	const Pino = service('Pino', { config: Config }, () => ({ info: (_: string) => {} }))
	type B = MetaOf<ReturnType<typeof bind<LoggerApi, MetaOf<typeof Logger>, typeof Pino>>>
	expectTypeOf<B['name']>().toEqualTypeOf<'Logger'>()
	expectTypeOf<B['graph']['Logger']['kind']>().toEqualTypeOf<'bound'>()
	expectTypeOf<B['graph']['Logger']['deps']>().toEqualTypeOf<'Pino'>()
	expectTypeOf<keyof B['graph']>().toEqualTypeOf<'Logger' | 'Pino' | 'Config'>()

	// A root-scope slot cannot be implemented by a scoped service.
	const ScopedLogger = service('ScopedLogger', { req: Request }, () => ({
		info: (_: string) => {},
	}))
	// @ts-expect-error: a request-scoped implementation of a root slot
	bind(Logger, ScopedLogger)
	// A scoped slot can be implemented by either.
	bind(
		Session,
		service('S', { req: Request }, () => ({ userId: '1' })),
	)
	bind(Session, { userId: '1' })
})

test('optional slots', async () => {
	const Metrics = slot('Metrics')<{ count(): void }>()
	const Svc = service('Svc', { metrics: optional(Metrics) }, ({ metrics }) => metrics)
	const app = await container().provide(Svc).build()
	expectTypeOf(app.get(Metrics)).toEqualTypeOf<{ count(): void } | undefined>()
	const bound = await container()
		.provide(Svc)
		.bind(Metrics, { count() {} })
		.build()
	expectTypeOf(bound.get(Metrics)).toEqualTypeOf<{ count(): void }>()

	const OptScoped = service('OptScoped', { session: optional(Session) }, ({ session }) => session)
	const scoped = await container().provide(OptScoped).build()
	scoped.open(PerRequest)
	scoped.open(PerRequest, bind(Session, { userId: '1' }))
})
