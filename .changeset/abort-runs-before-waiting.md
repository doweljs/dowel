---
"@doweljs/core": patch
---

Disposal now aborts every run beneath a container, in opened containers and nested runs included, before waiting for any of them, so runs that wait on each other during shutdown no longer deadlock.
