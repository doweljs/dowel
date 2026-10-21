import { service } from '@doweljs/core'
import { Clock } from './clock'

/** Generates ids. One counter per container keeps them unique across consumers. */
export const IdGenerator = service('IdGenerator', { clock: Clock }, ({ clock }) => {
	let n = 0
	return {
		next: (prefix: string) =>
			`${prefix}_${clock.now().getTime().toString(36)}_${(n++).toString(36)}`,
	}
})
