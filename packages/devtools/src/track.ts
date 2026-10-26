/**
 * `@doweljs/devtools/client`, as installed. On a dev server running the
 * devtools plugin, this module is replaced by one that keeps the containers
 * passed to `track()` and reports their state to the page; everywhere else,
 * `track()` does nothing, so an application can call it unconditionally.
 */

import type { Container } from '@doweljs/core'

/** Show a container in the devtools while a dev server runs them; a no-op otherwise. */
export function track(_container: Container<any>): void {}
