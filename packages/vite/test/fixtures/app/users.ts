import { service } from '@doweljs/core'
import { Db } from './db'
import { Logger } from './logger'

export const Users = service('Users', { db: Db, log: Logger }, ({ db, log }) => {
	log.info('users ready')
	return { version: 1, db }
})
