---
"@doweljs/core": minor
---

Services reached only through an execution are now created by the first run that needs them, instead of by `build()` or `open()`. They live in the store of their own scope, which shares them with later runs and disposes them; a failed creation fails only the runs that need it and is retried on the next demand. `get()` accepts only what the container creates with itself, and reports `CreatedOnDemand` for the rest: provide a service to create it eagerly.
