import { container } from '@doweljs/core'
import { Users } from './users'

export const app = await container().provide(Users).build()
