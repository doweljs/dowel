# @doweljs/vite

Vite integration for [dowel](../dowel): reloading by evolution, and diagnostics for the dependency graph.

```ts
// vite.config.ts
import dowel from '@doweljs/vite'
import { defineConfig } from 'vite'

export default defineConfig({ plugins: [dowel()] })
```

## Reloading

Keep the container with `hot()` from `@doweljs/core/evolve`, in the module that builds it:

```ts
// main.ts
import { hot } from '@doweljs/core/evolve'

export const app = await hot(import.meta.hot?.data, container().provide(Server).bind(Config, config))
```

The plugin makes that module accept its own updates. Edit any module beneath it, in any environment (client and SSR alike), and Vite evaluates it again: `hot()` builds a successor from the edited code, and it takes over from the running container without a reload.

- Requests and runs in flight finish on the code they started on; the next ones reach the successor. Code still holding the previous container, or the nodes of modules that were evaluated again, reaches the successor too.
- Keep the container, not the services you get from it: an instance saved from `app.get()` belongs to the generation that created it, which is disposed after an edit, closing what it adopted. Call `get()` where you use it.
- Effects (`ctx.whileActive()`) hand their state over, so a server can pass its socket or a pool its connections to the successor's instance.
- If the successor fails, because of an unbound slot or a factory that throws, Vite's error overlay shows why, and the running container keeps serving until an edit succeeds. [`@doweljs/devtools`](../devtools) marks it as failed meanwhile.

When the module is dropped, or the environment reloads in full, the plugin disposes the container it kept with `release()`, so nothing is left running behind the next one. In production builds `import.meta.hot` is undefined, and `hot()` is `build()`.

The plugin finds `hot()` and `track()` imported from `@doweljs/core/evolve` by name or as a namespace (`evolve.hot(…)`), not through a module of your own that re-exports them.

## Diagnostics

When two modules declare a slot or service with the same name, the plugin warns at transform time and names both locations. A successor resolves the nodes of earlier generations by name, so it would treat the two as one.

## Options

| Option    | Default             | Description                                                                       |
| --------- | ------------------- | --------------------------------------------------------------------------------- |
| `hot`     | `true`              | Whether modules that call `hot()` accept their updates and report failures.       |
| `include` | `/\.[cm]?[jt]sx?$/` | Module ids to analyze.                                                            |
| `exclude` | none                | Module ids to skip. `node_modules` is always skipped.                             |

Other plugins reach this one through its `api`:

- `api.graph()` returns the dependency graph known from static analysis.
- `api.addClientModule(id)` makes every module that calls `hot()` or `track()` also import the module `id`.

## How it works

The plugin only recognizes top-level declarations: `const X = service(…)`, `const T = slot(…)()`, `const S = scope(…)` and `const E = execution(…)`. That restriction is what makes the graph knowable without running any code.

In development, the plugin puts a snippet at the top of each module that calls `hot()`: it accepts the module's updates and reports failed successors to the error overlay. Declaring modules are left as they are, so an edit propagates up to the module that keeps the container. Production builds are left untouched.
