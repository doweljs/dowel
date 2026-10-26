import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, createServerModuleRunner, type ViteDevServer } from 'vite'
import type { ModuleRunner } from 'vite/module-runner'
import dowel, { type DowelPlugin } from '../src/index.ts'

const fixture = fileURLToPath(new URL('./fixtures/app', import.meta.url))

/** A module that keeps its container evolving. */
const EVOLVING = `import { container } from '@doweljs/core'
import { hot } from '@doweljs/core/evolve'
export const app = await hot(import.meta.hot?.data, container())
`
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
				{ find: /^@doweljs\/core\/evolve$/, replacement: join(dowelSrc, 'evolve.ts') },
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

	test('gives the module that calls hot() the snippet, leaving declaring modules alone', async () => {
		// The SSR transform renames `import.meta` and the imports.
		const main = await harness.server.environments.ssr.transformRequest('/main.ts')
		expect(main?.code).toContain('.hot.accept()')
		expect(main?.code).toContain('.onHotFailure(')
		expect(main?.code.indexOf('onHotFailure')).toBeLessThan(main?.code.indexOf('.hot)(') ?? 0)
		expect(main?.code).toContain('.hot.prune(() => ')
		expect(main?.code).toContain('"vite:beforeFullReload"')
		expect(main?.code.match(/\.release\(/g)).toHaveLength(2)
		// Only its own containers' failures, and a full reload only once it is this page's.
		expect(main?.code).toContain('failure.store !== __vite_ssr_import_meta__.hot.data')
		expect(main?.code).toContain('payload.path.endsWith(".html")')
		expect(main?.map).toBeTruthy()

		const users = await harness.server.environments.ssr.transformRequest('/users.ts')
		expect(users?.code).not.toContain('import.meta.hot')
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

	test('an edit builds a successor that takes over from the running container', async () => {
		type Main = typeof import('./fixtures/app/main.ts')
		const main = (await harness.runner.import('/main.ts')) as Main
		const { app } = main
		const before = app.get(main.Users)
		expect(before.version).toBe(1)

		const file = join(harness.root, 'users.ts')
		writeFileSync(file, (await Bun.file(file).text()).replace('version: 1', 'version: 2'))

		const after = await until(
			() => app.get(main.Users),
			(users) => users.version === 2,
		)
		expect(after.db).not.toBe(before.db)
		expect(after.db.takenOverFrom).toBe(before.db.id)
		await until(
			() => before.db.closed,
			(closed) => closed,
		)
		expect(app.get(main.Logger).lines).toEqual(['users ready'])
	})

	test('a successor that fails is reported for the error overlay, and the running container keeps serving', async () => {
		type Main = typeof import('./fixtures/app/main.ts')
		const main = (await harness.runner.import('/main.ts')) as Main
		const { app } = main
		const version = app.get(main.Users).version
		const reported: { message: string }[] = []
		const report = (data: { message: string }) => void reported.push(data)
		harness.server.environments.ssr.hot.on('dowel:error', report)

		try {
			// Another file than the last test edited, whose change the watcher could still be settling.
			const file = join(harness.root, 'db.ts')
			const source = await Bun.file(file).text()
			writeFileSync(
				file,
				source.replace('const connection', "throw new Error('db broke')\n\tconst connection"),
			)
			const [failure] = await until(
				() => reported,
				(failures) => failures.length > 0,
			)
			expect(failure?.message).toContain('db broke')
			expect(app.get(main.Users).version).toBe(version)
			writeFileSync(file, source)
		} finally {
			harness.server.environments.ssr.hot.off('dowel:error', report)
		}
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

	test('optimizes dowel and @doweljs/core/evolve together when serving', () => {
		const plugin = dowel()
		expect(hook(plugin, 'config')({}, { command: 'serve' })).toEqual({
			optimizeDeps: { include: ['@doweljs/core', '@doweljs/core/evolve'] },
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
			EVOLVING,
			'/app/main.ts',
		)
		expect(result).toBeUndefined()
	})

	test('failed evolutions reach the error overlay', () => {
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

	test('always accepts at the top, before a failing evaluation could skip an accept further down, and keeps a hashbang first', async () => {
		const plugin = dowel()
		hook(plugin, 'configResolved')({ command: 'serve', server: { hmr: true } })
		const transform = plugin.transform as { handler: Function }
		const context = { resolve: async () => null, warn: () => {} }
		const accepting = (await transform.handler.call(
			context,
			`${EVOLVING}if (import.meta.hot) import.meta.hot.accept()\n`,
			'/app/main.ts',
		)) as { code: string }
		expect(accepting.code.indexOf('\timport.meta.hot.accept();')).toBeLessThan(
			accepting.code.indexOf('await hot('),
		)

		const script = (await transform.handler.call(
			context,
			`#!/usr/bin/env bun\n${EVOLVING}`,
			'/app/cli.ts',
		)) as {
			code: string
		}
		expect(script.code.startsWith('#!/usr/bin/env bun\n// @doweljs/vite')).toBe(true)
	})

	test('gives a module that calls track() the devtools clients alone', async () => {
		const plugin = dowel()
		plugin.api.addClientModule('virtual:client')
		hook(plugin, 'configResolved')({ command: 'serve', server: { hmr: true } })
		const transform = plugin.transform as { handler: Function }
		const result = (await transform.handler.call(
			{ resolve: async () => null, warn: () => {} },
			`import { container } from '@doweljs/core'
import { track } from '@doweljs/core/evolve'
track(await container().build())
`,
			'/app/main.ts',
		)) as { code: string }
		expect(result.code).toContain('import "virtual:client"')
		expect(result.code).not.toContain('import.meta.hot')
	})

	test('leaves modules that do not call hot() or track() alone', async () => {
		const plugin = dowel()
		hook(plugin, 'configResolved')({ command: 'serve', server: { hmr: true } })
		const transform = plugin.transform as { handler: Function }
		const context = { resolve: async () => null, warn: () => {} }
		for (const code of [
			`import { service } from '@doweljs/core'\nexport const A = service('A', () => 1)\n`,
			`import { hot } from '@doweljs/core/evolve'\nexport { hot }\n`,
			`export const n = 1\n`,
		]) {
			expect(await transform.handler.call(context, code, '/app/a.ts')).toBeUndefined()
		}
	})
})
