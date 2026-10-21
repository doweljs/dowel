/**
 * `@doweljs/vite`: Vite integration for dowel.
 *
 * - Hot replacement: editing a service swaps it (and its dependents) inside
 *   live containers without reloading, keeping unrelated instances such as
 *   database connections alive.
 * - Diagnostics: duplicate slot or service names across modules are reported
 *   at transform time.
 * - A static graph of every declaration, which `@doweljs/devtools` draws.
 *
 * ```ts
 * import dowel from '@doweljs/vite'
 * export default defineConfig({ plugins: [dowel()] })
 * ```
 */

import type { Plugin } from 'vite'
import { analyze, mayDeclare } from './analysis/analyze.ts'
import { type Graph, Registry, sourcesToResolve } from './analysis/registry.ts'
import { inject } from './inject.ts'
import { showHotErrors } from './overlay.ts'

export type { Duplicate, Graph, GraphEdge, GraphNode } from './analysis/registry.ts'

export interface DowelPluginOptions {
	/**
	 * How modules that declare slots or services take part in hot replacement.
	 * - `auto` (default): modules register their declarations on every
	 *   evaluation, and accept their own updates when every export is a dowel
	 *   declaration. Mixed modules fall back to Vite's normal propagation.
	 * - `always`: every declaring module accepts its own updates.
	 * - `false`: no hot replacement code is injected.
	 */
	readonly hot?: 'auto' | 'always' | false
	/** Module ids to analyze. Default: every `.js`/`.ts` module. */
	readonly include?: RegExp | readonly RegExp[]
	/** Module ids to skip, in addition to `node_modules`, which is always skipped. */
	readonly exclude?: RegExp | readonly RegExp[]
}

/** What other plugins can ask of the dowel plugin, found by its name in the resolved config. */
export interface DowelPluginApi {
	/** The graph as currently known from static analysis. */
	graph(): Graph
	/**
	 * Has every module given hot code import `id` too, so it runs in each
	 * environment that declares nodes. The devtools load their client this way.
	 */
	addClientModule(id: string): void
}

export interface DowelPlugin extends Plugin {
	readonly api: DowelPluginApi
}

const DEFAULT_INCLUDE = /\.[cm]?[jt]sx?$/
const DEFAULT_EXCLUDE = /node_modules/

export default function dowel(options: DowelPluginOptions = {}): DowelPlugin {
	const hot = options.hot ?? 'auto'
	const registry = new Registry()
	const clients = new Set<string>()
	let serve = false
	/** Modules given hot code, by environment: each environment's runtime keeps its own registrations. */
	const hotModules = new Set<string>()
	const hotKey = (environment: string | undefined, id: string) => `${environment ?? ''}\0${id}`
	/**
	 * A module that registered declarations and now has none still registers
	 * the empty set, so @doweljs/core/hot releases its names for other modules.
	 */
	const release = (environment: string | undefined, code: string, id: string) => {
		if (!serve || hot === false || !hotModules.has(hotKey(environment, id))) return
		return inject(code, { id, locals: [], accept: false, clients: [] })
	}

	return {
		name: '@doweljs/vite',
		enforce: 'post',

		api: {
			graph: () => registry.graph(),
			addClientModule: (id) => void clients.add(id),
		},

		config(config, { command }) {
			// The injected `import "@doweljs/core/hot"` is invisible to the dependency scanner. Optimizing it
			// together with dowel up front avoids a re-optimization and reload on first load, during
			// which the two could be separate copies.
			if (command !== 'serve' || hot === false) return
			if (config.optimizeDeps?.exclude?.includes('@doweljs/core')) return
			return { optimizeDeps: { include: ['@doweljs/core', '@doweljs/core/hot'] } }
		},

		configResolved(config) {
			// No hot code where nothing replaces modules: test runners such as Vitest, or HMR turned off.
			serve =
				config.command === 'serve' &&
				config.server.hmr !== false &&
				process.env['VITEST'] === undefined
		},

		transform: {
			filter: {
				id: {
					include: patterns(options.include ?? DEFAULT_INCLUDE),
					exclude: [DEFAULT_EXCLUDE, ...patterns(options.exclude ?? [])],
				},
			},
			async handler(code, id) {
				const analysis = mayDeclare(code) ? analyze(id, code) : null
				if (analysis === null) {
					registry.delete(id)
					return release(this.environment?.name, code, id)
				}

				// Only the sources the graph can follow, resolved in parallel.
				const sources = sourcesToResolve(analysis)
				const resolved = new Map<string, string>()
				await Promise.all(
					[...sources].map(async (source) => {
						const target = await this.resolve(source, id)
						if (target !== null) resolved.set(source, target.id)
					}),
				)
				registry.set(id, analysis, resolved)

				for (const duplicate of registry.duplicatesOf(id)) {
					this.warn(
						`'${duplicate.id}' is declared more than once. Names must be unique; ` +
							`hot replacement treats these as the same node.\n  ${duplicate.modules.join('\n  ')}`,
					)
				}

				if (analysis.declarations.length === 0) return release(this.environment?.name, code, id)
				if (!serve || hot === false) return
				hotModules.add(hotKey(this.environment?.name, id))
				return inject(code, {
					id,
					locals: analysis.declarations.map((declaration) => declaration.local),
					accept: hot === 'always' || analysis.selfContained,
					clients: [...clients],
				})
			},
		},

		configureServer(server) {
			server.watcher.on('unlink', (file) => registry.deleteFile(file))
			if (hot !== false) showHotErrors(server)
		},
	}
}

function patterns(value: RegExp | readonly RegExp[]): RegExp[] {
	return value instanceof RegExp ? [value] : [...value]
}
