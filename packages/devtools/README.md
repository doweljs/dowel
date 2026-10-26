# @doweljs/devtools

A page on the Vite dev server showing [dowel](../dowel)'s dependency graph and the live state of every container an application shows it, in every environment. It draws the graph that [`@doweljs/vite`](../vite) finds by static analysis, so add both plugins:

```ts
// vite.config.ts
import devtools from '@doweljs/devtools'
import dowel from '@doweljs/vite'
import { defineConfig } from 'vite'

export default defineConfig({ plugins: [dowel(), devtools()] })
```

Show a container on the page with `track()` from `@doweljs/devtools/client`, where the container is built. Import it only while `import.meta.hot` exists, so that production builds drop the import and `@doweljs/devtools` stays a dev dependency:

```ts
export const app = await container().provide(Users).build()

if (import.meta.hot) {
	const { track } = await import('@doweljs/devtools/client')
	track(app)
	import.meta.hot.accept()
	import.meta.hot.dispose(() => app.dispose())
}
```

On the dev server, `@doweljs/devtools/client` is a module that keeps what it is given and answers the page; a disposed container drops off it. Under other tools, such as a test runner, it is the installed module, whose `track()` does nothing.

## The page

Open `/__dowel` on the dev server. It shows:

- every node, grouped by the module that declares it, with edges between them;
- scopes and bindings;
- the status of every instance, in each tracked container of each environment.

Dependencies shared by three or more services, such as a logger or the configuration, are listed on each dependent instead of drawn as edges, which keeps large graphs readable.

Select a node to see its direct subgraph, with parents above and children below. Click a neighbour to walk the graph; click the background or the breadcrumb to return to the whole graph.

## Options

| Option | Default      | Description                         |
| ------ | ------------ | ----------------------------------- |
| `path` | `'/__dowel'` | Path of the page on the dev server. |

## How it works

The plugin resolves `@doweljs/devtools/client` to a module of its own in every environment. That module keeps the containers passed to `track()`, weakly, and answers the page's polls with their `inspect()`. The static graph comes from the Vite plugin's `api.graph()`.

The page itself, in `ui/`, is bundled by the dev server's own Vite the first time it is opened. It is only ever served in development.
