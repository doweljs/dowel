# @doweljs/vite

Vite integration for [dowel](../dowel): diagnostics for the dependency graph, and the static graph that [`@doweljs/devtools`](../devtools) draws.

```ts
// vite.config.ts
import dowel from '@doweljs/vite'
import { defineConfig } from 'vite'

export default defineConfig({ plugins: [dowel()] })
```

## Diagnostics

When two modules declare a slot or service with the same name, the plugin warns at transform time and names both locations. Names identify nodes within a container, which rejects two nodes with one name when it is built.

## Reloading

The plugin changes no code. A module that builds a container reloads the way any Vite module does, and disposes the container it built before the edited code builds the next one:

```ts
// main.ts
export const app = await container().provide(Server).bind(Config, config).build()

if (import.meta.hot) {
	import.meta.hot.accept()
	import.meta.hot.dispose(() => app.dispose())
}
```

Without the `accept()`, an edit beneath the module propagates up to the nearest module that accepts it, or reloads the page. In production builds `import.meta.hot` is undefined and the block is dropped.

## Options

| Option    | Default             | Description                                           |
| --------- | ------------------- | ----------------------------------------------------- |
| `include` | `/\.[cm]?[jt]sx?$/` | Module ids to analyze.                                |
| `exclude` | none                | Module ids to skip. `node_modules` is always skipped. |

Other plugins reach this one through its `api`: `api.graph()` returns the dependency graph known from static analysis.

## How it works

The plugin only recognizes top-level declarations: `const X = service(…)`, `const T = slot(…)()`, `const S = scope(…)` and `const E = execution(…)`. That restriction is what makes the graph knowable without running any code.
