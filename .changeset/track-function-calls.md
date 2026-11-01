---
'@doweljs/core': minor
---

feat: track calls to a service whose instance is a function: disposal aborts `ctx.signal` for calls in flight and waits for them before disposing the instance and its dependencies, then refuses further calls; pass `{ track: false }` to opt out
