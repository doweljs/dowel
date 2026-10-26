import { container } from '@doweljs/core'
import { track } from '@doweljs/devtools/client'
import { Users } from './users'

export const app = await container().provide(Users).build()
track(app)
