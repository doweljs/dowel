---
"@doweljs/core": patch
---

A run whose container is disposed after it finished initializing but before its body started no longer runs the body against disposed instances. The body never starts, and the run rejects with `DISPOSED`.
