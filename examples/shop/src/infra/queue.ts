import { service, slot } from '@doweljs/core'
import type { AppEvent } from '../events'
import { Logger } from '../logging'

export interface Queue {
	enqueue(event: AppEvent): Promise<void>
	/** Hands every queued event to `handler`, oldest first, and returns how many there were. */
	drain(handler: (event: AppEvent) => Promise<void>): Promise<number>
}

export const Queue = slot('Queue')<Queue>()

export const MemoryQueue = service('MemoryQueue', { log: Logger }, ({ log }, ctx) => {
	const events: AppEvent[] = []
	const logger = log.child('queue')
	ctx.defer(() => logger.info('flushed', { pending: events.length }))
	return {
		enqueue: async (event) => {
			events.push(event)
			logger.info('enqueued', { kind: event.kind })
		},
		drain: async (handler) => {
			let handled = 0
			for (let event = events.shift(); event !== undefined; event = events.shift()) {
				await handler(event)
				handled++
			}
			return handled
		},
	} satisfies Queue
})
