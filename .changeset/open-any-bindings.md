---
'@doweljs/core': patch
---

fix: name a binding typed `any` passed to `open()`, such as one made by a failed import, instead of reporting it as a multi-binding or another scope's slot
