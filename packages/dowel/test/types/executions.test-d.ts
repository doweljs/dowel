/**
 * Type-level tests, checked by `tsc` and never executed: many of the calls
 * below are deliberately invalid and would throw at runtime.
 */
import { expectTypeOf } from 'bun:test'
import {
	type CreatedOnDemand,
	container,
	execution,
	type IncompleteExecutions,
	type Infer,
	type RunContext,
	scope,
	service,
	slot,
} from '../../src/index.ts'
import type { MetaOf } from '../../src/model/infer.ts'
import { Logger, Request, test } from './support.ts'

test('executions', () => {
	const JobScope = scope('job')
	const JobInput = slot('JobInput', { scope: JobScope })<{ id: string }>()
	const Other = slot('Other', { scope: JobScope })<number>()
	const JobRunner = service('JobRunner', { input: JobInput, log: Logger }, ({ input }) => ({
		run: () => input.id,
	}))
	const Job = execution('Job', { scope: JobScope, entry: JobRunner, inputs: { input: JobInput } })
	type Body = Parameters<Infer<typeof Job>>[1]
	expectTypeOf<Parameters<Extract<Body, Function>>[1]>().toEqualTypeOf<RunContext>()
	expectTypeOf(Job.scope).toEqualTypeOf<'root'>()
	type JobMeta = MetaOf<typeof Job>
	expectTypeOf<JobMeta['child']>().toEqualTypeOf<'job'>()
	expectTypeOf<JobMeta['inputs']>().toEqualTypeOf<'JobInput'>()
	expectTypeOf<JobMeta['graph']['Job']['deps']>().toEqualTypeOf<'JobRunner'>()

	const Scheduler = service('Scheduler', { job: Job }, ({ job }) => {
		expectTypeOf(job({ input: { id: 'x' } }, (runner) => runner.run())).toEqualTypeOf<
			Promise<string>
		>()
		// @ts-expect-error: the input is required
		job((runner) => runner.run())
		// @ts-expect-error: the input is required
		job({}, (runner) => runner.run())
		// @ts-expect-error: wrong value for the input
		job({ input: 1 }, (runner) => runner.run())
		// @ts-expect-error: no such input
		job({ input: { id: 'x' }, other: 1 }, (runner) => runner.run())
		return { job }
	})
	expectTypeOf(Scheduler.scope).toEqualTypeOf<'root'>()
	// Logger is needed by the entry, so it is required of the container.
	// @ts-expect-error: Logger missing
	container().provide(Scheduler).build()
	container()
		.provide(Scheduler)
		.bind(Logger, { info() {} })
		.build()

	// Inputs must cover what the entry needs in the child scope.
	const Needy = service('Needy', { input: JobInput, other: Other }, (d) => d)
	const Incomplete = execution('Incomplete', {
		scope: JobScope,
		entry: Needy,
		inputs: { input: JobInput },
	})
	const incomplete = container().provide(Incomplete)
	expectTypeOf(incomplete.build).toEqualTypeOf<
		IncompleteExecutions<{ readonly Incomplete: 'Other' }>
	>()
	// @ts-expect-error: not callable
	incomplete.build()
	// @ts-expect-error: inputs must be slots in the execution's scope
	execution('Bad', { scope: JobScope, entry: Needy, inputs: { request: Request } })

	// Without inputs, the runner takes only the body.
	const Plain = execution('Plain', { scope: JobScope, entry: Logger })
	const Uses = service('Uses', { plain: Plain }, ({ plain }) => {
		expectTypeOf(plain((log) => log)).toEqualTypeOf<Promise<{ info(message: string): void }>>()
		return plain
	})
	void Uses
})

test('execution traversal stops at same-scope runs without losing other dependency paths', () => {
	const JobScope = scope('job')
	const InnerInput = slot('InnerInput', { scope: JobScope })<number>()
	const OuterInput = slot('OuterInput', { scope: JobScope })<number>()
	const InnerEntry = service('InnerEntry', { input: InnerInput }, ({ input }) => input)
	const Inner = execution('Inner', {
		scope: JobScope,
		entry: InnerEntry,
		inputs: { input: InnerInput },
	})
	const Bridge = service('Bridge', { inner: Inner }, ({ inner }) => inner)
	const Direct = service('Direct', { input: OuterInput }, ({ input }) => input)
	const Entry = service('Entry', { bridge: Bridge, direct: Direct }, ({ direct }) => direct)

	// The nested run supplies InnerInput; the outer run still needs OuterInput
	// through a sibling path at the same depth as the execution boundary.
	const Incomplete = execution('Incomplete', { scope: JobScope, entry: Entry })
	expectTypeOf(container().provide(Incomplete).build).toEqualTypeOf<
		IncompleteExecutions<{ readonly Incomplete: 'OuterInput' }>
	>()
	const Complete = execution('Complete', {
		scope: JobScope,
		entry: Entry,
		inputs: { input: OuterInput },
	})
	container().provide(Complete).build()

	// A slot supplied by a nested run remains required when the outer entry
	// also reaches it directly. The boundary applies to edges, not slot names.
	const Shared = service('Shared', { bridge: Bridge, input: InnerInput }, ({ input }) => input)
	const MissingShared = execution('MissingShared', { scope: JobScope, entry: Shared })
	expectTypeOf(container().provide(MissingShared).build).toEqualTypeOf<
		IncompleteExecutions<{ readonly MissingShared: 'InnerInput' }>
	>()
})

test('execution graphs retain union entries and inputs unused by the entry', () => {
	const Job = scope('job')
	const Left = slot('Left', { scope: Job })<number>()
	const Right = slot('Right', { scope: Job })<number>()
	const Extra = slot('Extra', { scope: Job })<number>()
	const Run = execution('Run', {
		scope: Job,
		entry: Math.random() > 0.5 ? Left : Right,
		inputs: { left: Left, right: Right, extra: Extra },
	})

	expectTypeOf<keyof MetaOf<typeof Run>['graph']>().toEqualTypeOf<
		'Run' | 'Left' | 'Right' | 'Extra'
	>()
	container().provide(Run).build()
	// @ts-expect-error: even an unused input belongs to the run, not the root container
	container().provide(Run).bind(Extra, 1).build()
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

test('get() accepts what the container creates, not what only an execution reaches', async () => {
	const JobScope = scope('job')
	const Mailer = service('Mailer', () => ({ send: (to: string) => to }))
	const Send = execution('Send', { scope: JobScope, entry: Mailer })
	const Api = service('Api', { send: Send }, ({ send }) => send)
	const app = await container().provide(Api).build()
	expectTypeOf(app.get(Send)).toEqualTypeOf<Infer<typeof Send>>()
	// @ts-expect-error: only Send reaches it, so runs create it
	app.get(Mailer)
	expectTypeOf<Parameters<typeof app.get<typeof Mailer>>[0]>().toEqualTypeOf<
		CreatedOnDemand<'Mailer'>
	>()

	// Provided, it is created with the container.
	const both = await container().provide(Api, Mailer).build()
	expectTypeOf(both.get(Mailer).send).toEqualTypeOf<(to: string) => string>()
})
