---
'@doweljs/core': minor
---

Hot replacement is gone, and dowel is dependency injection alone. `@doweljs/core/hot` is removed: a running application is not rebuilt in place, which belongs to the platform that runs it. In development, dispose the container in `import.meta.hot.dispose()` and let the edited module build the next one. `inspect()` now throws `DISPOSED` on a disposed container, as `get()` and `open()` do.

`@doweljs/vite` and `@doweljs/devtools` are discontinued: without hot replacement, the plugin's static graph and the devtools page were a second, partial picture of what `inspect()` already reports.
