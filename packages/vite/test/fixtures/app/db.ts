import { service } from '@doweljs/core'

export const Db = service('Db', (ctx) => {
	const connection = { id: Math.random(), closed: false }
	ctx.defer(() => {
		connection.closed = true
	})
	return connection
})
