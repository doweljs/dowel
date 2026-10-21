import { service, slot } from '@doweljs/core'

export const Logger = slot('Logger')<{ lines: string[]; info(message: string): void }>()

export const MemoryLogger = service('MemoryLogger', () => {
	const lines: string[] = []
	return { lines, info: (message: string) => void lines.push(message) }
})
