/**
 * `@doweljs/devtools`: a page on the Vite dev server showing dowel's
 * dependency graph and the live state of every container an application
 * passes to `track()` from `@doweljs/devtools/client`, in every environment.
 * It draws the graph `@doweljs/vite` knows from static analysis, so that
 * plugin is required too.
 *
 * ```ts
 * import dowel from '@doweljs/vite'
 * import devtools from '@doweljs/devtools'
 * export default defineConfig({ plugins: [dowel(), devtools()] })
 * ```
 */

import type { DowelPlugin, DowelPluginApi } from '@doweljs/vite'
import type { Plugin, ResolvedConfig } from 'vite'
import { CLIENT_MODULE, clientModule } from './client.ts'
import { installDevtools } from './server.ts'

export type { ReportedContainer, State } from './protocol.ts'

export interface DevtoolsOptions {
	/** Path of the page on the dev server. Default: `/__dowel`. */
	readonly path?: string
}

const RESOLVED_CLIENT_MODULE = `\0${CLIENT_MODULE}`

export default function devtools(options: DevtoolsOptions = {}): Plugin {
	const base = basePath(options.path ?? '/__dowel')
	return {
		name: '@doweljs/devtools',
		apply: 'serve',
		// Before Vite's own resolver, which would find the installed no-op `track()`.
		enforce: 'pre',

		configResolved(config) {
			// Fails at startup when dowel() is missing, rather than on the page's first request.
			dowelApi(config)
		},

		resolveId: {
			filter: { id: exactly(CLIENT_MODULE) },
			handler: () => RESOLVED_CLIENT_MODULE,
		},

		load: {
			filter: { id: exactly(RESOLVED_CLIENT_MODULE) },
			handler() {
				return clientModule(this.environment.name)
			},
		},

		configureServer(server) {
			installDevtools(server, dowelApi(server.config), base)
		},
	}
}

function dowelApi(config: ResolvedConfig): DowelPluginApi {
	const plugin = config.plugins.find((p): p is DowelPlugin => p.name === '@doweljs/vite')
	if (plugin === undefined) {
		throw new Error(
			'@doweljs/devtools draws the graph @doweljs/vite knows. Add dowel() to the plugins too.',
		)
	}
	return plugin.api
}

/** `/__dowel/` and `/__dowel` are the same page; a trailing slash would double every URL in it. */
function basePath(path: string): string {
	const base = path.replace(/\/+$/, '')
	if (!base.startsWith('/')) {
		throw new Error(
			`The devtools path must start with '/' and not be the root; received '${path}'.`,
		)
	}
	return base
}

function exactly(id: string): RegExp {
	return new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
}
