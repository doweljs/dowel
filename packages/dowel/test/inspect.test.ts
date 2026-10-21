import { describe, expect, test } from 'bun:test'
import { bind, container, scope, service, slot } from '../src/index.ts'
import { Logger, memoryLogger, PerRequest, Request } from './support.ts'

describe('inspect', () => {
	test('reports nodes, edges, bindings, scopes and instance status', async () => {
		const Impl = service('Impl', () => memoryLogger())
		const Svc = service('Svc', { log: Logger, req: Request }, () => 1)
		const Many = slot('Many', { many: true })<number>()
		const One = service('One', () => 1)
		const app = await container()
			.provide(Svc, Many)
			.bind(Logger, Impl)
			.contribute(Many, One)
			.contribute(Many, 2)
			.build()
		const byName = new Map(app.inspect().map((node) => [node.name, node]))
		expect(byName.get('Impl')).toMatchObject({ kind: 'service', scope: 'root', status: 'ready' })
		expect(byName.get('Logger')).toMatchObject({
			kind: 'slot',
			binding: { kind: 'service', name: 'Impl' },
			status: 'ready',
		})
		expect(byName.get('Request')).toMatchObject({
			kind: 'slot',
			scope: 'request',
			binding: { kind: 'scope' },
		})
		expect(byName.get('Svc')).toMatchObject({ scope: 'request', status: null })
		expect(byName.get('Svc')!.deps).toEqual([
			{ key: 'log', name: 'Logger' },
			{ key: 'req', name: 'Request' },
		])
		expect(byName.get('Many')!.binding).toEqual({
			kind: 'many',
			items: [{ kind: 'service', name: 'One' }, { kind: 'value' }],
		})
		expect(byName.get('Many')!.deps).toEqual([{ key: '0', name: 'One' }])
		const child = await app.open(PerRequest, bind(Request, { url: '/' }))
		expect(child.inspect().find((n) => n.name === 'Svc')!.status).toBe('ready')
	})

	test("a service on a sibling scope has no status inside another scope's scope", async () => {
		const Side = scope('side')
		const SideSvc = service('SideSvc', () => 1, { scope: Side })
		const ReqSvc = service('ReqSvc', { req: Request }, () => 1)
		const app = await container().provide(SideSvc, ReqSvc).build()
		const child = await app.open(PerRequest, bind(Request, { url: '/' }))
		const byName = new Map(child.inspect().map((node) => [node.name, node]))
		expect(byName.get('ReqSvc')!.status).toBe('ready')
		expect(byName.get('SideSvc')!.status).toBeNull()
	})
})
