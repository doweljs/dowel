# @doweljs/vite

Vite integration for [dowel](../dowel): hot replacement of services, and diagnostics for the dependency graph.

```ts
// vite.config.ts
import dowel from '@doweljs/vite'
import { defineConfig } from 'vite'

export default defineConfig({ plugins: [dowel()] })
```

## Hot replacement

Edit a module, and every declaration in it is swapped inside every live container, in every environment (client and SSR alike), without a reload:

- Services that depend on what changed are recreated.
- Instances declared in untouched modules, such as a database connection, stay alive.
- Opened containers are disposed, so the next request sees the new code.

The terminal and the browser console log each swap, as in `[dowel] replaced Users`.

The new generation is initialized before the old one is torn down. If it fails, because of an unbound slot or a factory that throws, Vite's error overlay shows why, and the container keeps running its previous generation. [`@doweljs/devtools`](../devtools) marks the container as failed until an update succeeds.

A module accepts its own updates when every export is a slot, service, scope or execution, and it doesn't build a container. Other modules fall back to Vite's normal propagation, which still updates containers once it reaches a module that accepts. Set `hot: 'always'` to make every declaring module accept its own updates, or `hot: false` to inject nothing.

## Diagnostics

When two modules declare a slot or service with the same name, the plugin warns at transform time and names both locations. Hot replacement identifies nodes by name, so it would treat the two as one.

## Options

| Option    | Default             | Description                                           |
| --------- | ------------------- | ----------------------------------------------------- |
| `hot`     | `'auto'`            | `'auto'`, `'always'` or `false`. See above.           |
| `include` | `/\.[cm]?[jt]sx?$/` | Module ids to analyze.                                |
| `exclude` | none                | Module ids to skip. `node_modules` is always skipped. |

Other plugins reach this one through its `api`:

- `api.graph()` returns the dependency graph known from static analysis.
- `api.addClientModule(id)` makes every module with hot code also import the module `id`.

## How it works

The plugin only recognizes top-level declarations: `const X = service(…)`, `const T = slot(…)()`, `const S = scope(…)` and `const E = execution(…)`. That restriction is what makes the graph knowable without running any code.

In development, the plugin appends a snippet to each module that declares nodes. After every evaluation, the snippet registers the module's declarations with `@doweljs/core/hot`. Production builds are left untouched.
