import { service } from '@doweljs/core'

export const Db = service('Db', (ctx) => {
	const connection = { id: Math.random(), closed: false, takenOverFrom: undefined as unknown }
	ctx.whileActive((previous) => {
		connection.takenOverFrom = previous
		return () => connection.id
	})
	ctx.defer(() => {
		connection.closed = true
	})
	return connection
})
