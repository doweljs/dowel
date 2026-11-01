---
'@doweljs/core': patch
---

fix: bind a value typed `any`, such as what `JSON.parse()` returns, as a value, instead of leaving `build()` uncallable over a scope that is not one literal name
