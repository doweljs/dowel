import { service, slot } from '@doweljs/core'

export interface Clock {
	now(): Date
}

export const Clock = slot('Clock')<Clock>()

export const SystemClock = service('SystemClock', () => ({ now: () => new Date() }))
