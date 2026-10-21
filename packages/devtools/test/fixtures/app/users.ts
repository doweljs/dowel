import { service } from '@doweljs/core'

export const Db = service('Db', () => ({ connected: true }))
export const Users = service('Users', { db: Db }, ({ db }) => ({ db }))
