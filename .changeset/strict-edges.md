---
'@doweljs/core': patch
---

Four edges tightened. `open()` rejects, instead of handing out a container being torn down, when the container it opens from is disposed while its factories run. A container refuses `get()`, `open()` and `inspect()` as soon as its disposal starts, not a moment later. `open()` refuses a value for a slot that merely shares its name and scope with the one the graph reaches, which would have been written into the wrong cell; and the function `slot()` returns now gives the same slot every time it is called, so applying a type twice no longer declares two nodes. A service adopting one resource twice is told so, rather than told another service owns it.
