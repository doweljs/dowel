import { container } from '@doweljs/core'
import { Db } from './db'
import { Logger, MemoryLogger } from './logger'
import { Users } from './users'

export { Db, Logger, Users }
export const app = await container().provide(Users).bind(Logger, MemoryLogger).build()
