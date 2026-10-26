/**
 * What `@doweljs/devtools/client` resolves to on the dev server: `track()`
 * keeps the containers an application shows, and the module answers the
 * page's inspection requests with their state. Served by Vite as a module of
 * the project, so it has `import.meta.hot` in every environment.
 */

import { INSPECT, STATE } from './protocol.ts'

export const CLIENT_MODULE = '@doweljs/devtools/client'

/** The client module's source for one environment. */
export function clientModule(environment: string): string {
	return `const tracked = new Set();
let nextId = 1;
export function track(container) {
	if (typeof container?.inspect !== 'function') {
		throw new TypeError('track() takes a container from build() or open().');
	}
	tracked.add({ id: nextId++, ref: new WeakRef(container) });
}
// Collected or disposed containers (inspect() throws DISPOSED) drop out of the report.
function containers() {
	const result = [];
	for (const entry of tracked) {
		const container = entry.ref.deref();
		try {
			if (container !== undefined) result.push({ id: entry.id, nodes: container.inspect() });
			else tracked.delete(entry);
		} catch {
			tracked.delete(entry);
		}
	}
	return result;
}
if (import.meta.hot) {
	import.meta.hot.on(${JSON.stringify(INSPECT)}, ({ request }) => {
		import.meta.hot.send(${JSON.stringify(STATE)}, { request, environment: ${JSON.stringify(environment)}, containers: containers() });
	});
}
`
}
