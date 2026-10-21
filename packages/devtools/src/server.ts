/**
 * Dev-server integration: the devtools page and its JSON endpoints.
 */

import { isIP } from 'node:net'
import type { DowelPluginApi, Graph } from '@doweljs/vite'
import type { ViteDevServer } from 'vite'
import { Inspector } from './inspector.ts'
import { uiAssets } from './ui.ts'

/** Serves the devtools page and its JSON endpoints under `base`. */
export function installDevtools(server: ViteDevServer, dowel: DowelPluginApi, base: string): void {
	const inspector = new Inspector(Object.values(server.environments))

	server.middlewares.use(base, (req, res, next) => {
		// Added before Vite's own middlewares, so its host check (against DNS rebinding) is repeated here.
		if (!hostAllowed(server, req.headers.host)) {
			res.statusCode = 403
			res.end('Blocked request: this host is not allowed. Add it to server.allowedHosts.')
			return
		}
		// Relative URLs in the page resolve against its directory, so it is always served with the slash.
		if ((req.originalUrl ?? req.url ?? '/').split('?')[0] === base) {
			res.statusCode = 302
			res.setHeader('Location', `${base}/`)
			res.end()
			return
		}
		// Leading slashes collapse, so `//graph.json` is not read as a host name.
		const pathname = (req.url ?? '/').split('?')[0]!.replace(/^\/+/, '/')
		const json = (body: unknown): void => {
			res.setHeader('Content-Type', 'application/json')
			res.setHeader('Cache-Control', 'no-store')
			res.end(JSON.stringify(body))
		}
		switch (pathname) {
			case '/graph.json':
				json(relativeGraph(dowel.graph(), server.config.root))
				return
			case '/state.json':
				inspector.inspect().then(json, next)
				return
			default:
				uiAssets().then((assets) => {
					const asset = assets.get(pathname === '/' ? 'index.html' : pathname.slice(1))
					if (asset === undefined) return next()
					res.setHeader('Content-Type', asset.type)
					res.end(asset.body)
				}, next)
		}
	})
}

/** The same rule as Vite's host check: localhost and IP addresses, plus `server.allowedHosts`. */
function hostAllowed(server: ViteDevServer, header: string | undefined): boolean {
	const allowed = server.config.server.allowedHosts
	if (allowed === true || header === undefined) return true
	let hostname: string
	try {
		hostname = new URL(`http://${header}`).hostname
	} catch {
		return false
	}
	const bare = hostname.replace(/^\[|\]$/g, '')
	if (bare === 'localhost' || bare.endsWith('.localhost') || isIP(bare) !== 0) return true
	if (typeof server.config.server.host === 'string' && bare === server.config.server.host)
		return true
	return (allowed ?? []).some((entry) =>
		entry.startsWith('.') ? bare === entry.slice(1) || bare.endsWith(entry) : bare === entry,
	)
}

/** The graph with module ids relative to the project root, as the page shows them. */
function relativeGraph(graph: Graph, root: string): Graph {
	return {
		...graph,
		nodes: graph.nodes.map((node) => ({ ...node, module: relative(root, node.module) })),
		duplicates: graph.duplicates.map((duplicate) => ({
			...duplicate,
			modules: duplicate.modules.map((module) => relative(root, module)),
		})),
	}
}

function relative(root: string, module: string): string {
	const prefix = root.endsWith('/') ? root : `${root}/`
	return module.startsWith(prefix) ? module.slice(prefix.length) : module
}
