import { container } from '@doweljs/core'
import { hot } from '@doweljs/core/evolve'
import { Users } from './users'

export const app = await hot(import.meta.hot?.data, container().provide(Users))
