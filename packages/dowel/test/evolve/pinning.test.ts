import { describe, expect, test } from 'bun:test'
import { prepare } from '../../src/evolve.ts'
import { bind, container, execution, scope, service, slot } from '../../src/index.ts'
import { gate, nextTask, PerRequest, Request } from '../support.ts'

const Version = slot('Version')<number>()
const JobScope = scope('job')
const Input = slot('Input', { scope: JobScope })<string>()
const Worker = service('Worker', { input: Input, version: Version }, ({ input, version }) => ({
	run: () => `${input}@${version}`,
}))
const RunJob = execution('RunJob', { scope: JobScope, entry: Worker, inputs: { input: Input } })

const OuterScope = scope('outer')
const OuterInput = slot('OuterInput', { scope: OuterScope })<string>()
/** Starts a job of its own from within a run, through a runner it was given as a dependency. */
const Outer = service('Outer', { input: OuterInput, runJob: RunJob }, ({ input, runJob }) => ({
	nested: () => runJob({ input }, (worker) => worker.run()),
}))
const RunOuter = execution('RunOuter', {
	scope: OuterScope,
	entry: Outer,
	inputs: { input: OuterInput },
})

const Current = service(
	'Current',
	{ request: Request, version: Version },
	({ request, version }) => ({
		describe: () => `${request.url}@${version}`,
	}),
)

const generation = (version: number, onDispose?: () => void) => {
	const Lifetime = service('Lifetime', (ctx) => {
		if (onDispose !== undefined) ctx.defer(onDispose)
		return version
	})
	return container().provide(RunJob, RunOuter, Current, Lifetime).bind(Version, version)
}

describe('work pinned to a generation', () => {
	test('a run finishes on the generation it started in, and runs started later reach the successor', async () => {
		const first = await generation(1).build()
		const runJob = first.get(RunJob)
		const held = gate()
		const running = runJob({ input: 'a' }, async (worker) => {
			await held.promise
			return worker.run()
		})
		await nextTask()

		await (await prepare(first, generation(2))).activate()
		expect(await runJob({ input: 'b' }, (worker) => worker.run())).toBe('b@2')
		held.open()
		expect(await running).toBe('a@1')
		await first.dispose()
	})

	test('work a run starts stays on the generation the run started in', async () => {
		const first = await generation(1).build()
		const held = gate()
		const running = first.get(RunOuter)({ input: 'nested' }, async (outer) => {
			await held.promise
			return outer.nested()
		})
		await nextTask()

		await (await prepare(first, generation(2))).activate()
		held.open()
		expect(await running).toBe('nested@1')
		await first.dispose()
	})

	test('a superseded generation is disposed once its runs finish', async () => {
		const events: string[] = []
		const first = await generation(1, () => events.push('first disposed')).build()
		const held = gate()
		const running = first.get(RunJob)({ input: 'a' }, async (worker) => {
			await held.promise
			return worker.run()
		})
		await nextTask()

		const { retired } = await (await prepare(first, generation(2))).activate()
		void retired.then(() => events.push('retired'))
		await nextTask()
		expect(events).toEqual([])

		held.open()
		await running
		await retired
		expect(events).toEqual(['first disposed', 'retired'])
		await first.dispose()
	})

	test('a container opened before the succession stays on its generation, and is waited for', async () => {
		const events: string[] = []
		const first = await generation(1, () => events.push('first disposed')).build()
		const request = await first.open(PerRequest, bind(Request, { url: '/a' }))

		const { retired } = await (await prepare(first, generation(2))).activate()
		expect(request.superseded.aborted).toBe(true)
		expect(request.get(Current).describe()).toBe('/a@1')
		await using later = await first.open(PerRequest, bind(Request, { url: '/b' }))
		expect(later.get(Current).describe()).toBe('/b@2')
		expect(later.superseded.aborted).toBe(false)
		await nextTask()
		expect(events).toEqual([])

		await request.dispose()
		await retired
		expect(events).toEqual(['first disposed'])
	})

	test('a run hears that its generation was superseded, and may finish early', async () => {
		const first = await generation(1).build()
		const superseded = first.superseded
		const running = first.get(RunJob)({ input: 'a' }, (worker, { superseded }) => {
			expect(superseded.aborted).toBe(false)
			return new Promise<string>((resolve) => {
				superseded.addEventListener('abort', () => resolve(`${worker.run()} stopped`))
			})
		})
		await nextTask()

		await (await prepare(first, generation(2))).activate()
		expect(await running).toBe('a@1 stopped')
		expect(superseded.reason).toMatchObject({ code: 'SUPERSEDED' })
		await first.dispose()
	})

	test('a drain limit cancels what is still running when it passes', async () => {
		const first = await generation(1).build()
		const running = first.get(RunJob)({ input: 'a' }, (_, { signal }) => {
			return new Promise<string>((_, reject) => {
				signal.addEventListener('abort', () => reject(signal.reason))
			})
		})
		await nextTask()

		const { retired } = await (await prepare(first, generation(2))).activate({ drain: 10 })
		await expect(running).rejects.toMatchObject({ code: 'DISPOSED' })
		await retired
		await first.dispose()
	})

	test('disposing the latest container hurries the predecessors still draining behind it', async () => {
		const events: string[] = []
		const first = await generation(1, () => events.push('first disposed')).build()
		const running = first.get(RunJob)({ input: 'a' }, (_, { signal }) => {
			return new Promise<string>((_, reject) => {
				signal.addEventListener('abort', () => reject(signal.reason))
			})
		})
		await nextTask()

		const { container: second, retired } = await (await prepare(first, generation(2))).activate()
		await second.dispose()
		expect(events).toEqual(['first disposed'])
		await expect(running).rejects.toMatchObject({ code: 'DISPOSED' })
		await retired
	})

	test('disposing the latest container reaches generations draining behind its predecessors', async () => {
		const events: string[] = []
		const first = await generation(1, () => events.push('first disposed')).build()
		const outcome = first
			.get(RunJob)({ input: 'a' }, (_, { signal }) => {
				return new Promise<string>((_, reject) => {
					signal.addEventListener('abort', () => reject(signal.reason))
				})
			})
			.catch((error: unknown) => error)
		await nextTask()
		await (await prepare(first, generation(2))).activate()
		const third = await (await prepare(first, generation(3))).activate()
		await nextTask()
		expect(events).toEqual([])

		await third.container.dispose()
		expect(events).toEqual(['first disposed'])
		expect(await outcome).toMatchObject({ code: 'DISPOSED' })
	})

	test('an instance taken with get() belongs to its generation, unlike the container that forwards', async () => {
		const Connection = service('Connection', (ctx) => {
			const connection = { open: true }
			ctx.defer(() => {
				connection.open = false
			})
			return connection
		})
		const compose = (version: number) => generation(version).provide(Connection)
		const first = await compose(1).build()
		const kept = first.get(Connection)

		const { retired } = await (await prepare(first, compose(2))).activate()
		await retired
		expect(kept.open).toBe(false)
		expect(first.get(Connection).open).toBe(true)
		await first.dispose()
	})

	test('the container a successor took over from tells of each succession', async () => {
		const first = await generation(1).build()
		const firstSignal = first.superseded

		await (await prepare(first, generation(2))).activate()
		expect(firstSignal.aborted).toBe(true)
		const secondSignal = first.superseded
		expect(secondSignal.aborted).toBe(false)

		await (await prepare(first, generation(3))).activate()
		expect(secondSignal.aborted).toBe(true)
		expect(first.superseded.aborted).toBe(false)
		await first.dispose()
	})

	test('a kept runner rejects, rather than throws, once the latest generation cannot run it', async () => {
		const first = await generation(1).build()
		const runJob = first.get(RunJob)
		const Other = service('Other', () => 1)
		await (await prepare(first, container().provide(Other))).activate()

		let outcome: Promise<unknown> | undefined
		expect(() => {
			outcome = runJob({ input: 'a' }, (worker) => worker.run())
		}).not.toThrow()
		await expect(outcome).rejects.toMatchObject({ code: 'NOT_PROVIDED' })
		await first.dispose()
	})

	test('a kept runner follows each succession', async () => {
		const first = await generation(1).build()
		const runJob = first.get(RunJob)
		await (await prepare(first, generation(2))).activate()
		expect(await runJob({ input: 'a' }, (worker) => worker.run())).toBe('a@2')
		expect(await runJob({ input: 'b' }, (worker) => worker.run())).toBe('b@2')
		await (await prepare(first, generation(3))).activate()
		expect(await runJob({ input: 'c' }, (worker) => worker.run())).toBe('c@3')
		await first.dispose()
	})
})
