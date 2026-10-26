---
'@doweljs/core': minor
'@doweljs/vite': minor
'@doweljs/devtools': minor
---

Hot replacement is gone, and dowel is dependency injection alone. `@doweljs/core/hot` is removed: a running application is not rebuilt in place, which belongs to the platform that runs it. In development, dispose the container in `import.meta.hot.dispose()` and let the edited module build the next one. The Vite plugin no longer changes any module; its `hot` option and `api.addClientModule()` are removed, and it keeps the duplicate-name diagnostics and the static graph. The devtools show the containers an application passes to `track()` from `@doweljs/devtools/client`, a no-op outside the dev server. `inspect()` now throws `DISPOSED` on a disposed container, as `get()` and `open()` do.
