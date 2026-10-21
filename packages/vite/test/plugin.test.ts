import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite'
import type { ModuleRunner } from 'vite/module-runner'
import dowel, { type DowelPlugin } from '../src/index.ts'

const fixture = fileURLToPath(new URL('./fixtures/app', import.meta.url))
const dowelSrc = fileURLToPath(new URL('../../dowel/src', import.meta.url))

interface Harness extends AsyncDisposable {
	root: string
	server: ViteDevServer
	runner: ModuleRunner
}

/**
 * A dev server and module runner on a copy of the fixture. Each resource is
 * released if a later step fails, and all of them when the harness is.
 */
async function start(): Promise<Harness> {
	await using resources = new AsyncDisposableStack()
	const root = mkdtempSync(join(tmpdir(), 'dowel-vite-'))
	resources.defer(() => rmSync(root, { recursive: true, force: true }))
	cpSync(fixture, root, { recursive: true })
	const server = await createServer({
		root,
		configFile: false,
		logLevel: 'silent',
		server: { middlewareMode: true, ws: false },
		resolve: {
			alias: [
				{ find: /^@doweljs\/core\/hot$/, replacement: join(dowelSrc, 'hot.ts') },
				{ find: /^@doweljs\/core$/, replacement: join(dowelSrc, 'index.ts') },
			],
		},
		plugins: [dowel()],
	})
	resources.defer(() => server.close())
	const runner = createServerModuleRunner(server.environments.ssr, { hmr: { logger: false } })
	resources.defer(() => runner.close())
	const owned = resources.move()
	return { root, server, runner, [Symbol.asyncDispose]: () => owned.disposeAsync() }
}

async function until<T>(
	probe: () => T,
	predicate: (value: T) => boolean,
	timeout = 5000,
): Promise<T> {
	const started = Date.now()
	for (;;) {
		const value = probe()
		if (predicate(value)) return value
		if (Date.now() - started > timeout)
			throw new Error(`Timed out waiting; last value: ${String(value)}`)
		await new Promise((resolve) => setTimeout(resolve, 25))
	}
}

describe('@doweljs/vite', () => {
	let harness: Harness

	beforeAll(async () => {
		harness = await start()
	})
	afterAll(async () => {
		// Unset if starting failed, which released whatever it had acquired.
		await harness?.[Symbol.asyncDispose]()
	})

	test('transforms declaring modules with a hot snippet, leaving others alone', async () => {
		const users = await harness.server.environments.ssr.transformRequest('/users.ts')
		expect(users?.code).toMatch(/\.update\(".*users\.ts", \{ Users \}\)/)
		expect(users?.code).toContain('hot.accept()')
		expect(users?.map).toBeTruthy()

		// The root module builds the container, so it never accepts its own updates.
		const main = await harness.server.environments.ssr.transformRequest('/main.ts')
		expect(main?.code).not.toContain('.update(')
	})

	test('knows the static graph across modules', async () => {
		await harness.runner.import('/main.ts')
		const plugin = harness.server.config.plugins.find(
			(p) => p.name === '@doweljs/vite',
		) as DowelPlugin
		const users = plugin.api.graph().nodes.find((n) => n.id === 'service:Users')!
		expect(users.deps).toEqual([
			{ key: 'db', target: 'service:Db', optional: false },
			{ key: 'log', target: 'slot:Logger', optional: false },
		])
		expect(plugin.api.graph().duplicates).toEqual([])
	})

	test('replaces an edited service inside the live container', async () => {
		type Main = typeof import('./fixtures/app/main.ts')
		const main = (await harness.runner.import('/main.ts')) as Main
		const app = await main.app
		const before = app.get(main.Users)
		expect(before.version).toBe(1)
		const db = app.get(main.Db)

		const file = join(harness.root, 'users.ts')
		writeFileSync(file, (await Bun.file(file).text()).replace('version: 1', 'version: 2'))

		const after = await until(
			() => app.get(main.Users),
			(users) => users.version === 2,
		)
		expect(after.db).toBe(db)
		expect(db.closed).toBe(false)
		expect(app.get(main.Logger).lines).toEqual(['users ready', 'users ready'])
	})
})

describe('plugin configuration', () => {
	const hook = (
		plugin: ReturnType<typeof dowel>,
		name: 'config' | 'configResolved' | 'configureServer',
	) => {
		const value = plugin[name] as unknown
		return (typeof value === 'function' ? value : (value as { handler: Function }).handler) as (
			...args: unknown[]
		) => unknown
	}

	test('optimizes dowel and @doweljs/core/hot together when serving', () => {
		const plugin = dowel()
		expect(hook(plugin, 'config')({}, { command: 'serve' })).toEqual({
			optimizeDeps: { include: ['@doweljs/core', '@doweljs/core/hot'] },
		})
		expect(hook(plugin, 'config')({}, { command: 'build' })).toBeUndefined()
		expect(
			hook(plugin, 'config')(
				{ optimizeDeps: { exclude: ['@doweljs/core'] } },
				{ command: 'serve' },
			),
		).toBeUndefined()
	})

	test('injects nothing under a test runner', async () => {
		const plugin = dowel()
		const previous = process.env['VITEST']
		process.env['VITEST'] = 'true'
		try {
			hook(plugin, 'configResolved')({ command: 'serve', server: { hmr: true } })
		} finally {
			if (previous === undefined) delete process.env['VITEST']
			else process.env['VITEST'] = previous
		}
		const transform = plugin.transform as { handler: Function }
		const result = await transform.handler.call(
			{ resolve: async () => null, warn: () => {} },
			`import { service } from '@doweljs/core'\nexport const A = service('A', () => 1)\n`,
			'/app/a.ts',
		)
		expect(result).toBeUndefined()
	})

	test('hot replacement failures reach the error overlay', () => {
		const listeners = new Map<string, (data: unknown) => void>()
		const sent: unknown[] = []
		const ssr = {
			hot: {
				on: (event: string, listener: (data: unknown) => void) => listeners.set(event, listener),
			},
		}
		const client = { hot: { on: () => {}, send: (payload: unknown) => sent.push(payload) } }
		const server = { watcher: { on: () => {} }, environments: { client, ssr } }
		hook(dowel(), 'configureServer')(server)
		listeners.get('dowel:error')!({ message: 'boom', stack: 'at Svc' })
		expect(sent).toEqual([
			{ type: 'error', err: { message: 'boom', stack: 'at Svc', plugin: '@doweljs/vite' } },
		])
	})

	test('always skips node_modules, whatever else is excluded', () => {
		const transform = dowel({ exclude: /\.test\.ts$/ }).transform as {
			filter: { id: { exclude: RegExp[] } }
		}
		expect(transform.filter.id.exclude.map(String)).toEqual(['/node_modules/', '/\\.test\\.ts$/'])
	})

	test('a module that loses its last declaration still registers the empty set', async () => {
		const plugin = dowel()
		hook(plugin, 'configResolved')({ command: 'serve', server: { hmr: true } })
		const transform = plugin.transform as { handler: Function }
		const context = { resolve: async () => null, warn: () => {}, environment: { name: 'client' } }
		await transform.handler.call(
			context,
			`import { service } from '@doweljs/core'\nexport const A = service('A', () => 1)\n`,
			'/app/a.ts',
		)
		for (const code of [
			`import { service } from '@doweljs/core'\nexport const n = 1\n`,
			`export const n = 1\n`,
		]) {
			const result = (await transform.handler.call(context, code, '/app/a.ts')) as { code: string }
			expect(result.code).toContain('.update("/app/a.ts", {  })')
			expect(result.code).not.toContain('hot.accept()')
		}
		// A module that never declared anything is left alone.
		expect(
			await transform.handler.call(context, `export const n = 1\n`, '/app/b.ts'),
		).toBeUndefined()
		// Another environment has its own runtime, which never saw the declarations.
		const ssr = { ...context, environment: { name: 'ssr' } }
		expect(await transform.handler.call(ssr, `export const n = 1\n`, '/app/a.ts')).toBeUndefined()
	})

	test("the injected snippet releases the module's names when it is pruned", async () => {
		const plugin = dowel()
		hook(plugin, 'configResolved')({ command: 'serve', server: { hmr: true } })
		const transform = plugin.transform as { handler: Function }
		const result = (await transform.handler.call(
			{ resolve: async () => null, warn: () => {} },
			`import { service } from '@doweljs/core'\nexport const A = service('A', () => 1)\n`,
			'/app/a.ts',
		)) as { code: string }
		expect(result.code).toContain('import.meta.hot.prune(() => __dowel_hot__.forget("/app/a.ts"))')
	})
})
