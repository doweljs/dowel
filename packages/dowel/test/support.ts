/** Fixtures and helpers shared by the runtime tests. */

import { scope, slot } from '../src/index.ts'

export const Logger = slot('Logger')<{ lines: string[]; info(message: string): void }>()
/** The scope most tests open: one per request. */
export const PerRequest = scope('request')
export const Request = slot('Request', { scope: PerRequest })<{ url: string }>()

export const memoryLogger = () => {
	const lines: string[] = []
	return {
		lines,
		info: (message: string): void => {
			lines.push(message)
		},
	}
}

/** Resolves in a later task, once every reaction already queued has run. */
export const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** Passes what the types reject, so a test reaches the runtime's own checks. */
export const untyped = (value: unknown): any => value

/** A promise the test opens when it chooses, to hold work at a known point. */
export function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
	let open = (): void => {}
	const promise = new Promise<void>((resolve) => {
		open = resolve
	})
	return { promise, open }
}
