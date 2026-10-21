/**
 * The page, bundled from `ui/` with the dev server's own Vite on first
 * request. The sources sit beside `src` and `dist`, so one relative path
 * finds them from either.
 */

import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const ROOT = fileURLToPath(new URL('../ui/', import.meta.url))

const TYPES: Record<string, string> = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.css': 'text/css',
}

export interface Asset {
	readonly type: string
	readonly body: string | Uint8Array
}

let bundled: Promise<ReadonlyMap<string, Asset>> | null = null

/** The page's files by path (`index.html`, `assets/…`), bundled once and kept; a failed bundle is retried. */
export function uiAssets(): Promise<ReadonlyMap<string, Asset>> {
	bundled ??= bundle().catch((error: unknown) => {
		bundled = null
		throw error
	})
	return bundled
}

async function bundle(): Promise<Map<string, Asset>> {
	const result = await build({
		root: ROOT,
		configFile: false,
		logLevel: 'silent',
		// Relative asset URLs, so the page works under whatever path it is served from.
		base: './',
		build: { write: false },
	})
	const assets = new Map<string, Asset>()
	for (const output of Array.isArray(result) ? result : [result]) {
		if (!('output' in output))
			throw new Error('Bundling the devtools page unexpectedly started a watcher.')
		for (const file of output.output) {
			const type = TYPES[extname(file.fileName)] ?? 'application/octet-stream'
			assets.set(file.fileName, { type, body: file.type === 'chunk' ? file.code : file.source })
		}
	}
	return assets
}
