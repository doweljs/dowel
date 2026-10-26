---
'@doweljs/core': minor
'@doweljs/vite': minor
'@doweljs/devtools': minor
---

Containers evolve: `@doweljs/core/evolve` replaces `@doweljs/core/hot`. `prepare(previous, next)` builds a candidate beside the running container and `activate()` lets it take over: runs and opened containers finish on the generation they started in (their new `superseded` signal tells them it was superseded), new work reaches the successor, and the predecessor is disposed once its work drained. Root-scope services start what must not run twice with `ctx.whileActive()`, registered while their factory runs, whose stop function hands state over to the successor's instance of the same service; a candidate whose effects fail to start is discarded and its predecessor resumes. A superseded container forwards to the latest, resolving earlier generations' nodes by name, also across copies of dowel.

Nothing is shared between generations, so keep the container, not the services you get from it: an instance saved from `get()` is disposed with its generation after a successor takes over, closing what it adopted, where hot replacement used to carry unchanged instances over. The container, and runners taken from it, forward to the latest generation.

`hot(store, next)` reloads by evolution on every evaluation of a module, with `import.meta.hot.data` under Vite or `globalThis` under `bun --hot`; evaluations that overlap evolve one after the other, each effect getting a time limit (`timeout`, also an option of `activate()`) so one that never settles fails its evaluation rather than holding up the next, and `release(store)` disposes what a store keeps. The Vite plugin now only makes modules that call `hot()` accept their updates, report failures to the error overlay and release their container when dropped or reloaded in full; declaring modules are left alone, and its `hot` option is a boolean. The devtools show each application's generation and the generations still draining; an application kept without `hot()` shows there once passed to `track()`.

Everything but effects and the `superseded` signals lives in `@doweljs/core/evolve`, so applications that never evolve bundle none of it: about 0.5 KB gzipped is added to core, and `get()` stays within a few nanoseconds of before.
