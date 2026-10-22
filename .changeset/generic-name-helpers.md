---
"@doweljs/core": minor
---

A helper generic in a declaration's name can now use what it declares: pass it as a dependency, an execution's entry or input, a bound slot, a scope or to the builder. Declaring a node with a widened `string`, a pattern or a union is now reported at the name rather than in the declaration's type. When a helper passes such a name on, it is reported where the node is used: as a dependency, entry, input, bound or supplied slot, or a scope or its parent. `build()` reports what a builder is given, and any `string` or pattern name that a container reaches, a node's or a scope's, including one hidden behind a literal-named node. An `any` name is accepted where it is declared but reported wherever it is used, and so is a scope named `root`.
