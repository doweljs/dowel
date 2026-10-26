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
	warnings: string[]
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
	const warnings: string[] = []
	const server = await createServer({
		root,
		configFile: false,
		logLevel: 'silent',
		customLogger: {
			info: () => {},
			warn: (message) => void warnings.push(message),
			warnOnce: (message) => void warnings.push(message),
			error: () => {},
			clearScreen: () => {},
			hasErrorLogged: () => false,
			hasWarned: false,
		},
		server: { middlewareMode: true, ws: false },
		resolve: {
			alias: [{ find: /^@doweljs\/core$/, replacement: join(dowelSrc, 'index.ts') }],
		},
		plugins: [dowel()],
	})
	resources.defer(() => server.close())
	const runner = createServerModuleRunner(server.environments.ssr, { hmr: { logger: false } })
	resources.defer(() => runner.close())
	const owned = resources.move()
	return { root, server, runner, warnings, [Symbol.asyncDispose]: () => owned.disposeAsync() }
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

	test('leaves the code of every module as it is', async () => {
		const main = await harness.server.environments.ssr.transformRequest('/main.ts')
		expect(main?.code).not.toContain('@doweljs/vite')
		const users = await harness.server.environments.ssr.transformRequest('/users.ts')
		expect(users?.code).not.toContain('@doweljs/vite')
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

	test('warns when two modules declare one name', async () => {
		writeFileSync(
			join(harness.root, 'twin.ts'),
			`import { service } from '@doweljs/core'\nexport const Db = service('Db', () => 2)\n`,
		)
		await harness.server.environments.ssr.transformRequest('/twin.ts')
		const plugin = harness.server.config.plugins.find(
			(p) => p.name === '@doweljs/vite',
		) as DowelPlugin
		expect(plugin.api.graph().duplicates.map((duplicate) => duplicate.id)).toEqual(['Db'])
		expect(
			harness.warnings.some((warning) => warning.includes("'Db' is declared more than once")),
		).toBe(true)
	})
})

describe('plugin configuration', () => {
	test('always skips node_modules, whatever else is excluded', () => {
		const transform = dowel({ exclude: /\.test\.ts$/ }).transform as {
			filter: { id: { exclude: RegExp[] } }
		}
		expect(transform.filter.id.exclude.map(String)).toEqual(['/node_modules/', '/\\.test\\.ts$/'])
	})

	test('returns no transformed code for any module', async () => {
		const transform = dowel().transform as { handler: Function }
		const context = { resolve: async () => null, warn: () => {} }
		for (const code of [
			`import { service } from '@doweljs/core'\nexport const A = service('A', () => 1)\n`,
			`import { container } from '@doweljs/core'\nexport const app = await container().build()\n`,
			`export const n = 1\n`,
		]) {
			expect(await transform.handler.call(context, code, '/app/a.ts')).toBeUndefined()
		}
	})
})
