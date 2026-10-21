/**
 * Appends the development-only hot replacement snippet to a module that
 * declares slots or services. Appending keeps every original line in place,
 * so the generated source map is a plain extension of the original.
 */

import { MagicString } from 'magic-string'
import { HOT_ERROR } from './overlay.ts'

export interface InjectOptions {
	/** Module id, used as the registration key for `@doweljs/core/hot`. */
	readonly id: string
	/** Local names of the module's slot and service declarations. */
	readonly locals: readonly string[]
	/** Whether the module should accept its own updates. */
	readonly accept: boolean
	/** Modules other plugins asked every module with hot code to import. */
	readonly clients: readonly string[]
}

export function inject(
	code: string,
	options: InjectOptions,
): { code: string; map: ReturnType<MagicString['generateMap']> } {
	const s = new MagicString(code)
	const declarations = options.locals.join(', ')
	s.append(`

// @doweljs/vite: hot replacement
import * as __dowel_hot__ from "@doweljs/core/hot";
${options.clients.map((client) => `import ${JSON.stringify(client)};\n`).join('')}if (import.meta.hot) {
	__dowel_hot__.update(${JSON.stringify(options.id)}, { ${declarations} }).then(
		(result) => {
			if (result.changed.length > 0) console.info("[dowel] replaced " + result.changed.join(", "));
		},
		(error) => {
			const message = __dowel_hot__.describeFailure(error);
			console.error(message);
			import.meta.hot.send(${JSON.stringify(HOT_ERROR)}, { message, stack: String((error && error.stack) || "") });
		},
	);
	// Release the module's names once nothing imports it any more, so another module may declare them.
	import.meta.hot.prune(() => __dowel_hot__.forget(${JSON.stringify(options.id)}));
${options.accept ? '\timport.meta.hot.accept();\n' : ''}}
`)
	// Only appended code changes, so a map at token boundaries is exact enough.
	return { code: s.toString(), map: s.generateMap({ hires: 'boundary' }) }
}
