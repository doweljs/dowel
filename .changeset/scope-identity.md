---
'@doweljs/core': minor
---

A scope is the object `scope()` returned, compared by identity rather than by its names from the root down. Two distinct scopes sharing a name are rejected wherever they meet, with `DUPLICATE`: where a service declares its scope or dependencies, where a service stands in for a node, where an execution names its entry or inputs, and where a container is opened. Declare each scope once and import it where it is used. A scope can no longer take the name of a scope above it.
