---
"@doweljs/core": minor
---

Runners take an optional `{ signal }` after the body. Aborted before the body starts, the run stops its scope's factories, disposes what it created and rejects with the signal's reason; aborted while the body runs, it aborts the body's signal and settles as the body does.
