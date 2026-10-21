---
"@doweljs/core": minor
---

Runners take an optional `{ signal }` after the body. Aborted before the body starts, the run stops its scope's factories, disposes what it created and rejects with the signal's reason, leaving shared work above it running for others. Aborted while the body runs, it aborts the body's signal and the runs opened beneath it, and settles as the body does. A run started beneath a cancelled one never runs its body.
