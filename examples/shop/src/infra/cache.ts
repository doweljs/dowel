import { service, slot } from '@doweljs/core'
import { Clock } from './clock'

export interface Cache {
	get<T>(key: string): T | undefined
	set<T>(key: string, value: T, ttlMs?: number): void
	delete(key: string): void
}

export const Cache = slot('Cache')<Cache>()

/** Entries expire `ttlMs` after they were set, by the injected clock: at that instant they are gone. */
export const MemoryCache = service('MemoryCache', { clock: Clock }, ({ clock }) => {
	const entries = new Map<string, { value: unknown; expires: number }>()
	return {
		get: <T>(key: string) => {
			const entry = entries.get(key)
			if (!entry) return undefined
			if (clock.now().getTime() >= entry.expires) {
				entries.delete(key)
				return undefined
			}
			return entry.value as T
		},
		set: (key, value, ttlMs = 60_000) =>
			void entries.set(key, { value, expires: clock.now().getTime() + ttlMs }),
		delete: (key) => void entries.delete(key),
	} satisfies Cache
})
