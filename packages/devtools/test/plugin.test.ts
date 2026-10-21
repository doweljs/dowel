import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createServer as createHttpServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import dowel, { type Graph } from '@doweljs/vite'
import { createServer, createServerModuleRunner } from 'vite'
import devtools, { type State } from '../src/index.ts'

const root = fileURLToPath(new URL('./fixtures/app', import.meta.url))
const dowelSrc = fileURLToPath(new URL('../../dowel/src', import.meta.url))

interface Harness extends AsyncDisposable {
	readonly url: string
}

/**
 * A dev server with both plugins, serving over HTTP, with the fixture app
 * running. Each resource is released if a later step fails, and all of them
 * when the harness is.
 */
async function start(): Promise<Harness> {
	await using resources = new AsyncDisposableStack()
	const server = await createServer({
		root,
		configFile: false,
		logLevel: 'silent',
		server: { middlewareMode: true, ws: false },
		resolve: {
			alias: [
				{ find: /^@doweljs\/core\/hot$/, replacement: `${dowelSrc}/hot.ts` },
				{ find: /^@doweljs\/core$/, replacement: `${dowelSrc}/index.ts` },
			],
		},
		plugins: [dowel(), devtools()],
	})
	resources.defer(() => server.close())
	const runner = createServerModuleRunner(server.environments.ssr, { hmr: { logger: false } })
	resources.defer(() => runner.close())
	const http = createHttpServer(server.middlewares)
	const url = await listen(http)
	resources.defer(() => close(http))
	await runner.import('/main.ts')
	const owned = resources.move()
	return { url, [Symbol.asyncDispose]: () => owned.disposeAsync() }
}

/** Listens on a free local port, or rejects with the reason it cannot. */
function listen(http: Server): Promise<string> {
	return new Promise((resolve, reject) => {
		http.once('error', reject)
		http.listen(0, '127.0.0.1', () => {
			http.off('error', reject)
			const address = http.address()
			resolve(
				typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}` : '',
			)
		})
	})
}

function close(http: Server): Promise<void> {
	return new Promise((resolve, reject) =>
		http.close((error) => (error ? reject(error) : resolve())),
	)
}

describe('@doweljs/devtools', () => {
	let harness: Harness
	let url: string

	beforeAll(async () => {
		harness = await start()
		url = harness.url
	})

	afterAll(async () => {
		// Unset if starting failed, which released whatever it had acquired.
		await harness?.[Symbol.asyncDispose]()
	})

	test('serves the page', async () => {
		const html = await fetch(`${url}/__dowel/`).then((r) => r.text())
		expect(html).toContain('<title>dowel</title>')
	})

	test('serves the static graph, with modules relative to the root', async () => {
		const graph = (await fetch(`${url}/__dowel/graph.json`).then((r) => r.json())) as Graph
		expect(graph.nodes.map((node) => [node.id, node.module])).toEqual([
			['service:Db', 'users.ts'],
			['service:Users', 'users.ts'],
		])
	})

	test("reports each environment's live containers", async () => {
		const state = (await fetch(`${url}/__dowel/state.json`).then((r) => r.json())) as State
		const [container] = state['ssr'] ?? []
		expect(container?.status).toEqual({ state: 'current', error: null })
		expect(container?.nodes.map((node) => [node.name, node.status])).toEqual([
			['Db', 'ready'],
			['Users', 'ready'],
		])
	})

	test('refuses to run without the dowel plugin', async () => {
		await expect(
			createServer({ root, configFile: false, logLevel: 'silent', plugins: [devtools()] }),
		).rejects.toThrow('Add dowel() to the plugins too')
	})
})
