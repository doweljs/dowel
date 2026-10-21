/**
 * Hot replacement of services in live containers. Experimental: intended
 * for development through `@doweljs/vite`, never loaded in production.
 *
 * Importing this module enables container tracking. A build tool calls
 * {@link update} every time a module that declares scopes, slots, services
 * or executions is evaluated. Nodes are matched across evaluations by name,
 * and a name belongs to the module that first declared it.
 *
 * Invalidation is per module and conservative. A factory may close over
 * anything else in its module, so every declaration of a re-evaluated
 * module counts as changed, whether or not its own source did. The latest
 * declarations are compiled into a proposal for each live container:
 *
 * - root-scope instances whose node was not re-declared and whose
 *   dependencies are unchanged are carried over,
 * - everything else is created again while the committed generation keeps
 *   running,
 * - once the proposal has initialized it is committed: opened containers and
 *   executions are disposed, replaced instances are disposed, and stale
 *   references held by modules that were not re-evaluated keep working.
 *
 * A proposal that fails to compile or initialize is discarded. The container
 * stays on its committed generation and {@link snapshot} reports it as
 * failed until a later update succeeds. Because replaced instances are only
 * disposed after their replacements exist, a service holding an exclusive
 * resource (a listening port) cannot be replaced while the previous
 * instance holds it; such an update fails and says why.
 *
 * Updates are applied one at a time, in the order they arrive. The next one
 * starts once the previous one committed: tearing down an old generation
 * waits for its running executions, which must not hold up later updates.
 * Each update's promise still settles only after its own teardown.
 */

import { registry } from './hot/registry.ts'
import { follow } from './hot/replace.ts'
import { hooks } from './runtime/hooks.ts'

export type { ContainerSnapshot, ContainerStatus, HotUpdate } from './hot/updates.ts'
export { describeFailure, forget, snapshot, update } from './hot/updates.ts'

// Importing this module turns tracking on; containers built from here on compile against the latest declarations.
hooks.enabled = true
hooks.canonical = registry.canonical
hooks.withAliases = registry.withAliases
hooks.follow = follow
