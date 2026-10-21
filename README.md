# dowel

Type-complete dependency injection for TypeScript, with hot replacement and devtools for Vite.

| Package                                  | Description                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| [`@doweljs/core`](packages/dowel)        | The library: slots, services, scopes, executions and containers.                    |
| [`@doweljs/vite`](packages/vite)         | Vite plugin: hot replacement of services, and diagnostics for the dependency graph. |
| [`@doweljs/devtools`](packages/devtools) | The dependency graph and live instance state, on the Vite dev server.               |

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

## Example

[`examples/shop`](examples/shop) is the service layer of a storefront, with about 40 nodes:

- configuration and logging slots;
- async infrastructure, such as a database and a queue;
- domain services, and services scoped to a request;
- test fakes, which the tests put in place with `override()` on the production composition.

Run `bun run dev` inside it and open `/__dowel`.

## Development

```sh
bun install
bun run check     # lint, type checks, the type budget, tests, the package check and knip
bun test
bun run build
```

The checks beyond tests:

- **Type-level tests** live in `*.test-d.ts` files. `tsc` checks them; they never run.
- **`bun run typecheck:ts59`** checks the core under TypeScript 5.9, the oldest version supported.
- **`bun run typecheck:budget`** fails when checking the core takes 10% more type instantiations than `scripts/type-budget.json` records. Run `bun scripts/type-budget.ts --update` to accept a deliberate cost.
- **`bun run check:package`** checks `@doweljs/core` as users install it. It packs the package, installs it into a temporary project, and compiles a fixture that exports one of everything with declarations on, under TypeScript 5.9 and 7 and several compiler settings. Then it runs a smoke test under Node.
- **`bun run scale`** regenerates the 300-service stress test for the type-level model.
