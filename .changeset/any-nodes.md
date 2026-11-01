---
'@doweljs/core': patch
---

fix: report a node typed `any`, such as one a failed import leaves, where it is passed: by key among dependencies and inputs, by option for a scope or entry, and by method at `build()` for `provide()`, `bind()`, `contribute()` and `override()`; nothing else reads it as every name or scope
