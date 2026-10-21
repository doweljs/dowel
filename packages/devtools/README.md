# @doweljs/devtools

A page on the Vite dev server showing [dowel](../dowel)'s dependency graph and the live state of every container, in every environment. It draws the graph that [`@doweljs/vite`](../vite) finds by static analysis, so add both plugins:

```ts
// vite.config.ts
import devtools from '@doweljs/devtools'
import dowel from '@doweljs/vite'
import { defineConfig } from 'vite'

export default defineConfig({ plugins: [dowel(), devtools()] })
```

## The page

Open `/__dowel` on the dev server. It shows:

- every node, grouped by the module that declares it, with edges between them;
- scopes and bindings;
- the status of every instance, in each container of each environment;
- containers whose last hot replacement failed, marked as such.

Dependencies shared by three or more services, such as a logger or the configuration, are listed on each dependent instead of drawn as edges, which keeps large graphs readable.

Select a node to see its direct subgraph, with parents above and children below. Click a neighbour to walk the graph; click the background or the breadcrumb to return to the whole graph.

## Options

| Option | Default      | Description                         |
| ------ | ------------ | ----------------------------------- |
| `path` | `'/__dowel'` | Path of the page on the dev server. |

## How it works

The plugin registers a client module with `@doweljs/vite`, which every module with hot code imports. In each environment, that client answers the page's polls with `snapshot()` from `@doweljs/core/hot`. The static graph comes from the Vite plugin's `api.graph()`.

The page itself, in `ui/`, is bundled by the dev server's own Vite the first time it is opened. It is only ever served in development.
