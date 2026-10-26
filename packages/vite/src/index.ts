/**
 * `@doweljs/vite`: Vite integration for dowel.
 *
 * - Evolution: a module that keeps its container with `hot()` from
 *   `@doweljs/core/evolve` accepts its own updates, so every edit beneath it
 *   builds a successor that takes over from the running container, and a
 *   successor that fails shows in the error overlay.
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
	 * Whether modules that call `hot()` accept their own updates and report
	 * failed evolutions in the error overlay. Default: `true`.
	 */
	readonly hot?: boolean
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
	 * Has every module that calls `hot()` or `track()` import `id` too, so it
	 * runs in each environment that keeps a container. The devtools load
	 * their client this way.
	 */
	addClientModule(id: string): void
}

export interface DowelPlugin extends Plugin {
	readonly api: DowelPluginApi
}

const DEFAULT_INCLUDE = /\.[cm]?[jt]sx?$/
const DEFAULT_EXCLUDE = /node_modules/

export default function dowel(options: DowelPluginOptions = {}): DowelPlugin {
	const hot = options.hot ?? true
	const registry = new Registry()
	const clients = new Set<string>()
	let serve = false

	return {
		name: '@doweljs/vite',
		enforce: 'post',

		api: {
			graph: () => registry.graph(),
			addClientModule: (id) => void clients.add(id),
		},

		config(config, { command }) {
			// The injected `import "@doweljs/core/evolve"` is invisible to the dependency scanner.
			// Optimizing it together with dowel up front avoids a re-optimization and reload on first
			// load, during which the two could be separate copies.
			if (command !== 'serve' || !hot) return
			if (config.optimizeDeps?.exclude?.includes('@doweljs/core')) return
			return { optimizeDeps: { include: ['@doweljs/core', '@doweljs/core/evolve'] } }
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
					return
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
							`a successor resolves earlier generations' nodes by name.\n  ${duplicate.modules.join('\n  ')}`,
					)
				}

				if (!serve || !hot || !(analysis.evolves || analysis.tracks)) return
				return inject(code, { evolves: analysis.evolves, clients: [...clients] })
			},
		},

		configureServer(server) {
			server.watcher.on('unlink', (file) => registry.deleteFile(file))
			if (hot) showHotErrors(server)
		},
	}
}

function patterns(value: RegExp | readonly RegExp[]): RegExp[] {
	return value instanceof RegExp ? [value] : [...value]
}
