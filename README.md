# dowel

Type-complete dependency injection for TypeScript: [`@doweljs/core`](packages/dowel).

```ts
const Logger = slot('Logger')<{ info(message: string): void }>()
const PerRequest = scope('request')
const CurrentRequest = slot('CurrentRequest', { scope: PerRequest })<IncomingRequest>()
const Database = service('Database', { config: Config }, async ({ config }) => connect(config.dbUrl))
const UserDirectory = service('UserDirectory', { db: Database, log: Logger }, ({ db, log }) => ({
	list() {
		log.info('listing users')
		return db.query('select * from users')
	},
}))

// Remove the .bind() and build() stops being callable: MissingBindings<{ Logger: "UserDirectory" }>
const app = await container().provide(UserDirectory).bind(Logger, console).build()

// A container for one request, disposed at the end of the block.
await using request = await app.open(PerRequest, CurrentRequest.of(req))
```

[`examples/shop`](examples/shop) is the service layer of a storefront: about 40 nodes, async infrastructure, request-scoped services, and tests that `override()` the production composition with fakes. Run `bun run dev` inside it.
