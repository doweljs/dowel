/** Fixtures shared by the hot replacement tests. */

import { afterEach } from 'bun:test'
import { reset } from '../../src/hot/updates.ts'
import { slot } from '../../src/index.ts'
import { hooks } from '../../src/runtime/hooks.ts'

/** Disposes every tracked container and forgets every registration after each test. */
export function resetAfterEach(): void {
	afterEach(async () => {
		for (const tracked of [...hooks.containers]) {
			await Promise.resolve((tracked as unknown as AsyncDisposable)[Symbol.asyncDispose]()).catch(
				() => undefined,
			)
		}
		reset()
	})
}

export const Logger = slot('Logger')<{ info(message: string): void }>()
