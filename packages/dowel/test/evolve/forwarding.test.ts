import { afterAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hot, prepare } from '../../src/evolve.ts'
import { bind, container, scope, service, slot } from '../../src/index.ts'
import { untyped } from '../support.ts'

/** The declarations of one evaluation of a module, as a reload re-evaluates it. */
function declare(version: number) {
	const Session = scope('session')
	const User = slot('User', { scope: Session })<string>()
	const Greeter = service('Greeter', () => ({ greet: (name: string) => `${name}@${version}` }))
	const Welcome = service('Welcome', { user: User, greeter: Greeter }, ({ user, greeter }) =>
		greeter.greet(user),
	)
	return { Session, User, Greeter, Welcome }
}

const compose = (nodes: ReturnType<typeof declare>) =>
	container().provide(nodes.Greeter, nodes.Welcome)

describe('forwarding to the latest generation', () => {
	test('a superseded container forwards get(), open(), inspect() and dispose() to the latest', async () => {
		const v1 = declare(1)
		const first = await compose(v1).build()
		await (await prepare(first, compose(declare(2)))).activate()
		const v3 = declare(3)
		const { container: third } = await (await prepare(first, compose(v3))).activate()

		expect(first.get(v1.Greeter).greet('ada')).toBe('ada@3')
		await using session = await first.open(v1.Session, bind(v1.User, 'ada'))
		expect(session.get(v1.Welcome)).toBe('ada@3')
		expect(session.get(v3.Welcome)).toBe('ada@3')
		expect(first.inspect()).toEqual(third.inspect())

		await first.dispose()
		expect(() => third.get(v3.Greeter)).toThrow(
			expect.objectContaining({ code: 'DISPOSED' }) as never,
		)
	})

	test('only a successor resolves nodes of earlier generations, by name', async () => {
		const v1 = declare(1)
		const v2 = declare(2)
		const fresh = await compose(v2).build()

		expect(() => fresh.get(v1.Greeter)).toThrow(
			expect.objectContaining({ code: 'NOT_PROVIDED' }) as never,
		)
		await fresh.dispose()
	})
})

describe('a successor from another copy of dowel', () => {
	// What `bun --hot` does: every module is evaluated again, dowel included.
	const copy = mkdtempSync(join(tmpdir(), 'dowel-copy-'))
	cpSync(fileURLToPath(new URL('../../src', import.meta.url)), copy, { recursive: true })
	afterAll(() => rmSync(copy, { recursive: true, force: true }))

	test('takes over from what hot() built, with what it handed over, and resolves its nodes', async () => {
		const store = {}
		const events: string[] = []
		const Port = service('Port', (ctx) => {
			ctx.whileActive(() => () => 'socket')
			return 1
		})
		const first = await hot(store, container().provide(Port))

		const other = await import(join(copy, 'index.ts'))
		const evolve = await import(join(copy, 'evolve.ts'))
		const NextPort = other.service('Port', (ctx: any) => {
			ctx.whileActive((previous: unknown) => {
				events.push(`started from ${String(previous)}`)
			})
			return 2
		})
		const second = await evolve.hot(store, other.container().provide(NextPort))

		expect(events).toEqual(['started from socket'])
		expect(first.get(Port)).toBe(2)
		expect(second.get(Port)).toBe(2)
		expect(
			evolve.snapshot().find((lineage: { nodes: unknown[] }) => lineage.nodes.length > 0),
		).toMatchObject({
			generation: 2,
		})
		await first.dispose()
	})

	test('cannot take over from what plain build() built in another copy', async () => {
		const first = await container().build()
		const evolve = await import(join(copy, 'evolve.ts'))
		const other = await import(join(copy, 'index.ts'))

		await expect(evolve.prepare(first, other.container())).rejects.toMatchObject({
			code: 'INVALID_NODE',
		})
		await first.dispose()
	})

	test('is refused by a container built from scratch', async () => {
		const other = await import(join(copy, 'index.ts'))
		const Port = service('Port', () => 1)
		const fresh = await other
			.container()
			.provide(other.service('Port', () => 2))
			.build()

		expect(() => untyped(fresh).get(Port)).toThrow('different copy of dowel')
		await fresh.dispose()
	})
})
