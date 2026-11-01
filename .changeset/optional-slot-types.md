---
'@doweljs/core': patch
---

fix: keep `undefined` in a slot's or service's type when exactOptionalPropertyTypes is off, so factories, `Infer` and bindings see it
