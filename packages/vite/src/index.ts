/**
 * `@doweljs/vite`: Vite integration for dowel.
 *
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

export type { Duplicate, Graph, GraphEdge, GraphNode } from './analysis/registry.ts'

export interface DowelPluginOptions {
	/** Module ids to analyze. Default: every `.js`/`.ts` module. */
	readonly include?: RegExp | readonly RegExp[]
	/** Module ids to skip, in addition to `node_modules`, which is always skipped. */
	readonly exclude?: RegExp | readonly RegExp[]
}

/** What other plugins can ask of the dowel plugin, found by its name in the resolved config. */
export interface DowelPluginApi {
	/** The graph as currently known from static analysis. */
	graph(): Graph
}

export interface DowelPlugin extends Plugin {
	readonly api: DowelPluginApi
}

const DEFAULT_INCLUDE = /\.[cm]?[jt]sx?$/
const DEFAULT_EXCLUDE = /node_modules/

export default function dowel(options: DowelPluginOptions = {}): DowelPlugin {
	const registry = new Registry()

	return {
		name: '@doweljs/vite',
		enforce: 'post',

		api: {
			graph: () => registry.graph(),
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
						`'${duplicate.id}' is declared more than once. Names must be unique within a container, ` +
							`which rejects two nodes with one name when it is built.\n  ${duplicate.modules.join('\n  ')}`,
					)
				}
			},
		},

		configureServer(server) {
			server.watcher.on('unlink', (file) => registry.deleteFile(file))
		},
	}
}

function patterns(value: RegExp | readonly RegExp[]): RegExp[] {
	return value instanceof RegExp ? [value] : [...value]
}
