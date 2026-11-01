import { slot } from '@doweljs/core'

export interface Clock {
	now(): Date
}

export const Clock = slot('Clock')<Clock>()

export const SystemClock = Clock.implement(() => ({ now: () => new Date() }))
