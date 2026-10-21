import { service, slot } from '@doweljs/core'
import { Config } from './config'

export interface Logger {
	readonly lines: readonly string[]
	info(message: string, data?: Record<string, unknown>): void
	warn(message: string, data?: Record<string, unknown>): void
	child(prefix: string): Logger
}

export interface Metrics {
	increment(name: string, by?: number): void
	timing(name: string, ms: number): void
	snapshot(): Record<string, number>
}

export const Logger = slot('Logger')<Logger>()
export const Metrics = slot('Metrics')<Metrics>()

export const ConsoleLogger = service('ConsoleLogger', { config: Config }, ({ config }) => {
	const lines: string[] = []
	const make = (prefix: string): Logger => ({
		lines,
		info: (message, data) => {
			lines.push(`${prefix}${message}${data ? ` ${JSON.stringify(data)}` : ''}`)
			if (config.env === 'development') console.info(`${prefix}${message}`, data ?? '')
		},
		warn: (message, data) => {
			lines.push(`${prefix}WARN ${message}${data ? ` ${JSON.stringify(data)}` : ''}`)
			console.warn(`${prefix}${message}`, data ?? '')
		},
		child: (name) => make(`${prefix}${name}: `),
	})
	return make('')
})

export const MemoryMetrics = service('MemoryMetrics', () => {
	const counters = new Map<string, number>()
	return {
		increment: (name: string, by = 1) => void counters.set(name, (counters.get(name) ?? 0) + by),
		timing: (name: string, ms: number) => void counters.set(`${name}.ms`, ms),
		snapshot: () => Object.fromEntries(counters),
	} satisfies Metrics
})
