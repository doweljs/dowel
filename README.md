# dowel

Type-complete dependency injection for TypeScript: [`@doweljs/core`](packages/dowel).

```ts
const Logger = slot('Logger')<{ info(message: string): void }>()
const PerRequest = scope('request')
const Request = slot('Request', { scope: PerRequest })<IncomingRequest>()
const Db = service('Db', { config: Config }, async ({ config }) => connect(config.dbUrl))
const Users = service('Users', { db: Db, log: Logger }, ({ db, log }) => ({
	list() {
		log.info('listing users')
		return db.query('select * from users')
	},
}))

// Remove the bind() and build() stops being callable: MissingBindings<{ Logger: "Users" }>
const app = await container().provide(Users).bind(Logger, console).build()

// A container for one request, disposed at the end of the block.
await using request = await app.open(PerRequest, bind(Request, req))
```

[`examples/shop`](examples/shop) is the service layer of a storefront: about 40 nodes, async infrastructure, request-scoped services, and tests that `override()` the production composition with fakes. Run `bun run dev` inside it.
