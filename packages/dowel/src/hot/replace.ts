/**
 * Replacing one container's generation: compile a proposal from the latest
 * declarations, carry over what did not change, initialize the rest, and
 * commit.
 */

import {
	type CachedPlan,
	type Compiled,
	type ExecutionPlan,
	isCached,
	type Plan,
} from '../compile/plan.ts'
import { withCleanup } from '../errors.ts'
import { ROOT } from '../nodes/node.ts'
import { disposeStore } from '../runtime/dispose.ts'
import { compileWithHooks, type HotAccess } from '../runtime/hooks.ts'
import { initialize } from '../runtime/resolve.ts'
import { type Chain, type InstanceRecord, newStore, type Store, UNSET } from '../runtime/store.ts'

/** A committed replacement: `teardown` disposes what it replaced. */
export interface Committed {
	readonly teardown: Promise<void>
}

/**
 * Builds and initializes a proposal, then commits it. Throws without
 * touching the committed generation when the proposal fails; otherwise
 * resolves at the commit, before the replaced generation is torn down.
 */
export async function replaceGeneration(access: HotAccess): Promise<Committed> {
	const next = compileWithHooks(access.composition)
	const isUnchanged = unchangedIn(access.compiled, next)

	// Carry unchanged instances into the proposal's store; the rest will be replaced.
	const rootPlan = next.scopes.get(ROOT.name)!
	const nextByKey = new Map<string, CachedPlan>()
	// Instances created on demand are carried too, so a run does not create them again.
	for (const plan of rootPlan.cached) nextByKey.set(planKey(plan), plan)
	const oldRoot = access.root
	const root = newStore(ROOT, rootPlan.cells, oldRoot.owned, null)
	// Carried records are shared by both stores until the commit re-points them at their new plan.
	const carried = new Map<InstanceRecord, CachedPlan>()
	const carriedPlans = new Set<Plan>()
	// Records come in creation order, so an instance's dependencies were considered before it.
	const carriable = (plan: CachedPlan): boolean =>
		isUnchanged(plan) &&
		// The proposal may have created one itself meanwhile, or be creating it.
		root.cells[plan.cell] === UNSET &&
		root.pending?.[plan.cell] === undefined &&
		// One the proposal created anew must not be left holding the instance it replaces.
		plan.deps.every((dep) => !isCached(dep.plan) || carriedPlans.has(dep.plan))
	let seen = 0
	const carryNew = (): void => {
		for (; seen < oldRoot.records.length; seen++) {
			const record = oldRoot.records[seen]!
			const plan = nextByKey.get(planKey(record.plan))
			if (plan !== undefined && carriable(plan)) {
				root.cells[plan.cell] = oldRoot.cells[record.plan.cell]
				root.records.push(record)
				carried.set(record, plan)
				carriedPlans.add(plan)
			}
		}
	}
	carryNew()

	// Discarding the proposal disposes only what it created, containers opened meanwhile included.
	const discard = () => disposeWithout(root, carried, 'a discarded replacement')
	await withCleanup(() => initialize(rootPlan.needs.order, [root]), discard)
	// Runs may have created instances on demand in the old root while the proposal initialized,
	// or be creating them; those are waited for, so that they are carried and not created twice.
	if (oldRoot.pending !== null) await Promise.allSettled(oldRoot.pending)
	carryNew()
	// The container was disposed meanwhile, carried instances included: there is nothing to commit to.
	if (oldRoot.disposed) return { teardown: discard() }

	// Commit. From here on the container runs the new generation, whatever happens below.
	access.swap(next, root)
	for (const [record, plan] of carried) record.plan = plan
	successors.set(oldRoot, { store: root, plans: next.plans })
	return { teardown: disposeWithout(oldRoot, carried, 'replaced services') }
}

/** Whether a plan of `next` stands for the same declarations as in `committed`, its dependencies included. */
function unchangedIn(committed: Compiled, next: Compiled): (plan: Plan) => boolean {
	const committedIds = declaringIds(committed)
	const nextIds = declaringIds(next)
	const memo = new Map<Plan, boolean>()
	const isUnchanged = (plan: Plan): boolean => {
		let result = memo.get(plan)
		if (result === undefined) {
			result = compare(plan)
			memo.set(plan, result)
		}
		return result
	}
	const compare = (plan: Plan): boolean => {
		const before = committedIds.get(planKey(plan))
		const after = nextIds.get(planKey(plan))
		// A value no node declares (a contributed item) comes from the composition, which never changes.
		if (before === undefined && after === undefined) return plan.kind === 'value'
		if (before !== after) return false
		// A root runner follows the root's successor (see `follow`), so what it runs may change.
		if (plan.kind === 'execution') return true
		return plan.deps.every((dep) => isUnchanged(dep.plan))
	}
	return isUnchanged
}

const planKey = (plan: Plan): string => `${plan.kind}:${plan.scope.name}:${plan.name}`

/**
 * The declared node behind each plan, by plan key. A slot bound to a service
 * and a service overridden by another share that service's plan; the node
 * that declared the plan (no binding of its own) is the one whose identity
 * matters.
 */
function declaringIds(compiled: Compiled): Map<string, number> {
	const ids = new Map<string, number>()
	for (const node of compiled.graph) {
		const key = planKey(node.plan)
		if (node.binding === null || !ids.has(key)) ids.set(key, node.id)
	}
	return ids
}

/** Disposes a store of one generation, except the records carried into the other. */
function disposeWithout(
	store: Store,
	carried: ReadonlyMap<InstanceRecord, unknown>,
	what: string,
): Promise<void> {
	const own = store.records.filter((record) => !carried.has(record))
	store.records.splice(0, store.records.length, ...own)
	return disposeStore(store, what)
}

/** A replaced root's successor: the root and plans that took over. */
interface Successor {
	readonly store: Store
	readonly plans: ReadonlyMap<number, Plan>
}

const successors = new WeakMap<Store, Successor>()

/**
 * A root runner outlives hot replacement of its root (the instance holding it
 * may be carried over), so it follows the root's successors to the latest
 * generation. Deeper runners belong to opened containers, which replacement disposes.
 */
export function follow(plan: ExecutionPlan, base: Chain): [ExecutionPlan, Chain] {
	if (base.length !== 1) return [plan, base]
	let current = plan
	let root = base[0]!
	let successor = successors.get(root)
	while (successor !== undefined) {
		const next = successor.plans.get(plan.id)
		if (next?.kind !== 'execution') break
		current = next
		root = successor.store
		successor = successors.get(root)
	}
	return root === base[0] ? [plan, base] : [current, [root]]
}
