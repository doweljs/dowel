---
'@doweljs/core': minor
---

feat: declare a service that fills a slot with `Slot.implement()`, which needs no name and stands for the slot it's bound to, or with `Slot.implementAs()` when something refers to it; both check the factory against the slot, and `inspect()` reports the slot a service implements
