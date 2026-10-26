import { container } from '@doweljs/core'
import { hot } from '@doweljs/core/evolve'
import { Db } from './db'
import { Logger, MemoryLogger } from './logger'
import { Users } from './users'

export { Db, Logger, Users }
export const app = await hot(
	import.meta.hot?.data,
	container().provide(Users).bind(Logger, MemoryLogger),
)
