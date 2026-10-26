/** The client module: imported by every module that calls `hot()`, it answers inspection requests. */

import { INSPECT, STATE } from './protocol.ts'

export const CLIENT_MODULE = 'virtual:dowel-devtools/client'

/** The client module's source for one environment. */
export function clientModule(environment: string): string {
	return `import { snapshot } from "@doweljs/core/evolve";
if (import.meta.hot) {
	import.meta.hot.on(${JSON.stringify(INSPECT)}, ({ request }) => {
		import.meta.hot.send(${JSON.stringify(STATE)}, { request, environment: ${JSON.stringify(environment)}, lineages: snapshot() });
	});
}
`
}
