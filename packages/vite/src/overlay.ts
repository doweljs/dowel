/**
 * Failed evolutions in Vite's error overlay. The injected code reports a
 * failed `hot()` over its environment's hot channel; the plugin shows it in
 * the browser, whichever environment it came from.
 */

import type { ViteDevServer } from 'vite'

/** The event injected code sends when `hot()` fails. */
export const HOT_ERROR = 'dowel:error'

export interface HotErrorMessage {
	readonly message: string
	readonly stack: string
}

/** Shows the failures every environment of `server` reports in the browser's error overlay. */
export function showHotErrors(server: ViteDevServer): void {
	for (const environment of Object.values(server.environments)) {
		environment.hot.on(HOT_ERROR, (data: HotErrorMessage) => {
			server.environments.client.hot.send({
				type: 'error',
				err: { message: data.message, stack: data.stack, plugin: '@doweljs/vite' },
			})
		})
	}
}
