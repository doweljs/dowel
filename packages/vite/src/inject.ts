/**
 * The development-only snippet put at the top of a module that keeps a
 * container evolving with `hot()`, or shows one in devtools with `track()`.
 * At the top, so it runs before the module's own code: the evaluation it
 * accepts is the one that may fail, which would leave an accept further
 * down unregistered. Accepting twice is harmless.
 */

import { MagicString } from 'magic-string'
import { HOT_ERROR } from './overlay.ts'

export interface InjectOptions {
	/** Whether the module calls `hot()`, so it accepts its updates and reports failures; else it only imports the clients. */
	readonly evolves: boolean
	/** Modules other plugins asked every module with hot code to import. */
	readonly clients: readonly string[]
}

export function inject(
	code: string,
	options: InjectOptions,
): { code: string; map: ReturnType<MagicString['generateMap']> } {
	const s = new MagicString(code)
	const imports = options.clients.map((client) => `import ${JSON.stringify(client)};\n`).join('')
	const snippet = options.evolves
		? `// @doweljs/vite: evolve on every update, reporting failures in the error overlay
import * as __dowel_evolve__ from "@doweljs/core/evolve";
${imports}if (import.meta.hot) {
	const stop = __dowel_evolve__.onHotFailure((failure) => {
		try {
			// Every module that calls hot() listens; each reports the failures of its own containers.
			if (failure.store !== import.meta.hot.data) return;
			import.meta.hot.send(${JSON.stringify(HOT_ERROR)}, { message: "[dowel] " + failure.message, stack: String((failure.error && failure.error.stack) || "") });
		} catch {
			// The dev server is gone, and with it whoever would show this.
			stop();
		}
	});
	import.meta.hot.dispose(stop);
	// Dropped, or about to be evaluated from scratch: what it kept is disposed rather than left running.
	import.meta.hot.prune(() => __dowel_evolve__.release(import.meta.hot.data));
	import.meta.hot.on("vite:beforeFullReload", (payload) => {
		// Vite's client reloads a page only for its own HTML file; it tells listeners before it decides.
		if (typeof document !== "undefined" && payload.path && payload.path.endsWith(".html")) {
			const page = decodeURI(location.pathname);
			const path = import.meta.env.BASE_URL + payload.path.slice(1);
			if (page !== path && payload.path !== "/index.html" && !(page.endsWith("/") && page + "index.html" === path)) return;
		}
		return __dowel_evolve__.release(import.meta.hot.data);
	});
	import.meta.hot.accept();
}
`
		: `// @doweljs/vite: devtools clients
${imports}`
	// After a hashbang, which must stay the first line.
	const hashbang = /^#!.*\n?/.exec(code)
	if (hashbang === null) s.prepend(snippet)
	else s.appendLeft(hashbang[0].length, snippet)
	return { code: s.toString(), map: s.generateMap({ hires: 'boundary' }) }
}
