import { describe, expect, test } from 'bun:test'
import type { DowelPluginApi } from '@doweljs/vite'
import type { ViteDevServer } from 'vite'
import devtools from '../src/index.ts'

type Handler = (req: unknown, res: FakeResponse, next: () => void) => void
type Listener = (data: unknown, client: unknown) => void

interface FakeResponse {
	statusCode: number
	headers: Record<string, string>
	body: string
	setHeader(name: string, value: string): void
	end(body?: string): void
}

const dowel: DowelPluginApi = {
	graph: () => ({ nodes: [], duplicates: [] }),
	addClientModule: () => {},
}

/** Replies for a tab: to the request being made, unless another is named. */
type Reply = (tab: object, request?: number) => void

/**
 * Just enough of a dev server for the devtools: one environment, a middleware
 * stack, the dowel plugin. `answer` is called for every inspection request.
 */
function fakeServer(answer: (reply: Reply, request: number) => void) {
	const listeners = new Map<string, Listener>()
	let mounted: { path: string; handler: Handler } | null = null
	const environment = {
		hot: {
			on: (event: string, listener: Listener) => listeners.set(event, listener),
			send: (event: string, { request }: { request: number }) => {
				if (event !== 'dowel:inspect') return
				answer((tab, quoted = request) => {
					const lineages = [{ id: (tab as { container?: number }).container ?? 1, nodes: [] }]
					listeners.get('dowel:state')!({ request: quoted, environment: 'client', lineages }, tab)
				}, request)
			},
		},
	}
	const server = {
		environments: { client: environment },
		config: {
			root: '/app',
			server: { allowedHosts: ['dev.example'] },
			plugins: [{ name: '@doweljs/vite', api: dowel }],
		},
		middlewares: { use: (path: string, handler: Handler) => (mounted = { path, handler }) },
	} as unknown as ViteDevServer
	/** Requests a full path; like Connect, the handler sees it without the mount path. */
	const request = (url: string, host = 'localhost:5173') =>
		new Promise<FakeResponse>((resolve) => {
			const res: FakeResponse = {
				statusCode: 200,
				headers: {},
				body: '',
				setHeader(name, value) {
					this.headers[name] = value
				},
				end(body = '') {
					this.body = body
					resolve(this)
				},
			}
			const { path, handler } = mounted!
			handler(
				{ url: url.slice(path.length) || '/', originalUrl: url, headers: { host } },
				res,
				() => res.end('next'),
			)
		})
	return { server, request, mounted: () => mounted }
}

/** Installs the devtools on a server the way Vite would. */
function install(server: ViteDevServer, path?: string): void {
	const configureServer = devtools(path === undefined ? {} : { path }).configureServer as (
		server: ViteDevServer,
	) => void
	configureServer(server)
}

describe('devtools server', () => {
	test('the page is served under its path with a trailing slash', async () => {
		const fake = fakeServer(() => {})
		install(fake.server, '/__dowel/')
		expect(fake.mounted()!.path).toBe('/__dowel')
		const bare = await fake.request('/__dowel')
		expect(bare.statusCode).toBe(302)
		expect(bare.headers['Location']).toBe('/__dowel/')
		// Leading slashes collapse, so this is not read as a host name.
		expect((await fake.request('/__dowel//graph.json')).headers['Content-Type']).toBe(
			'application/json',
		)
	})

	test('requests from hosts Vite would not allow are refused', async () => {
		const fake = fakeServer(() => {})
		install(fake.server)
		expect((await fake.request('/__dowel/graph.json', 'attacker.example')).statusCode).toBe(403)
		expect((await fake.request('/__dowel/graph.json', 'dev.example:5173')).statusCode).toBe(200)
		expect((await fake.request('/__dowel/graph.json', '127.0.0.1:5173')).statusCode).toBe(200)
	})

	test('state comes from this round only, and tabs sharing an environment are kept apart', async () => {
		const tabA = {}
		const tabB = {}
		let open = [tabA, tabB]
		const fake = fakeServer((reply) => {
			for (const tab of open) reply(tab)
		})
		install(fake.server)
		const first = JSON.parse((await fake.request('/__dowel/state.json')).body)
		expect(first.client.map((c: { id: string }) => c.id)).toEqual(['1.1', '2.1'])
		// Tab B closed.
		open = [tabA]
		const second = JSON.parse((await fake.request('/__dowel/state.json')).body)
		expect(second.client.map((c: { id: string }) => c.id)).toEqual(['1.1'])
	})

	test('container ids stay with their tab, whatever order tabs answer in', async () => {
		const tabA = { container: 10 }
		const tabB = { container: 20 }
		let open = [tabA, tabB]
		const fake = fakeServer((reply) => {
			for (const tab of open) reply(tab)
		})
		install(fake.server)
		const ids = async () =>
			JSON.parse((await fake.request('/__dowel/state.json')).body)
				.client.map((c: { id: string }) => c.id)
				.sort()
		expect(await ids()).toEqual(['1.10', '2.20'])
		open = [tabB, tabA]
		expect(await ids()).toEqual(['1.10', '2.20'])
		open = [tabB]
		expect(await ids()).toEqual(['2.20'])
	})

	test('a tab that opens later is reported too', async () => {
		const open: object[] = [{}, {}]
		const fake = fakeServer((reply) => {
			for (const tab of open) reply(tab)
		})
		install(fake.server)
		const ids = async () =>
			JSON.parse((await fake.request('/__dowel/state.json')).body).client.map(
				(c: { id: string }) => c.id,
			)
		expect(await ids()).toEqual(['1.1', '2.1'])
		await Bun.sleep(150)
		open.push({})
		expect(await ids()).toEqual(['1.1', '2.1', '3.1'])
	})

	test('a late answer to an earlier poll does not count for the current one', async () => {
		const tabA = {}
		const tabB = {}
		let late: (() => void) | null = null
		const fake = fakeServer((reply, request) => {
			reply(tabA)
			// Tab B answers the first request only, and only once the second is under way.
			if (request === 0) late = () => reply(tabB, request)
			else late?.()
		})
		install(fake.server)
		await fake.request('/__dowel/state.json')
		const second = JSON.parse((await fake.request('/__dowel/state.json')).body)
		expect(second.client.map((c: { id: string }) => c.id)).toEqual(['1.1'])
	})
})
