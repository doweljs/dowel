/**
 * The names hot replacement knows: the module that declares each name, the
 * latest node declared under it, and the ids of every node that has carried
 * it. Names identify nodes across module evaluations.
 */

import type { Compiled, GraphNode } from '../compile/plan.ts'
import type { DeclaredNode, ScopeNode } from '../nodes/node.ts'

export type Declared = DeclaredNode | ScopeNode

interface Registration {
	readonly node: Declared
	readonly module: string
}

/** What registering a module's declarations changed. */
export interface Claim {
	/** Names re-declared, or returning from another module after it released them. */
	readonly changed: readonly string[]
	/** The node now registered under each key whose registration changed. */
	readonly changedNodes: ReadonlyMap<string, Declared>
}

/** Scopes and other nodes have separate namespaces; slots, services and executions share one. */
const keyOf = (node: { readonly kind: string; readonly name: string }): string =>
	`${node.kind === 'scope' ? 'scope' : 'node'}:${node.name}`

class Registry {
	private readonly latest = new Map<string, Registration>()
	private readonly knownIds = new Map<string, Set<number>>()

	/** The module that declares a node's name, if any does. */
	ownerOf(node: Declared): string | undefined {
		return this.latest.get(keyOf(node))?.module
	}

	/** The latest node declared under a node's name, or the node itself. */
	readonly canonical = <N extends Declared>(node: N): N =>
		(this.latest.get(keyOf(node))?.node as N | undefined) ?? node

	/**
	 * Registers what a module declares now. Names it no longer declares are
	 * released so a declaration can move to another module; the ids they
	 * carried are kept, so stale references follow the name to its new module.
	 */
	claim(moduleId: string, nodes: readonly Declared[]): Claim {
		const declared = new Set(nodes.map(keyOf))
		for (const [key, registration] of this.latest) {
			if (registration.module === moduleId && !declared.has(key)) this.latest.delete(key)
		}

		const changed: string[] = []
		const changedNodes = new Map<string, Declared>()
		for (const node of nodes) {
			const key = keyOf(node)
			const before = this.latest.get(key)
			if (before?.node === node) continue
			this.latest.set(key, { node, module: moduleId })
			changedNodes.set(key, node)
			// Re-declared here, or returning after its module released it (a moved declaration).
			if (before !== undefined || this.knownIds.has(key)) changed.push(node.name)
			let ids = this.knownIds.get(key)
			if (ids === undefined) {
				ids = new Set()
				this.knownIds.set(key, ids)
			}
			ids.add(node.id)
		}
		return { changed, changedNodes }
	}

	/** Releases every name a module declares, together with the ids they carried. */
	forget(moduleId: string): void {
		for (const [key, registration] of this.latest) {
			if (registration.module !== moduleId) continue
			this.latest.delete(key)
			// Otherwise a later node of the same name would answer for these stale objects.
			this.knownIds.delete(key)
		}
	}

	/** Makes plans reachable through every node object that ever carried a name. */
	readonly withAliases = (compiled: Compiled): Compiled => {
		const plans = new Map(compiled.plans)
		for (const node of compiled.graph) {
			const ids = this.knownIds.get(keyOf(node))
			if (ids === undefined) continue
			for (const id of ids) if (!plans.has(id)) plans.set(id, node.plan)
		}
		return { ...compiled, plans }
	}

	clear(): void {
		this.latest.clear()
		this.knownIds.clear()
	}
}

export const registry = new Registry()

/**
 * Whether a container compiled a different node than the one now registered
 * under any of these keys. The first registration of a node a container
 * already uses changes nothing for it.
 */
export function usesReplacedNode(
	compiled: Compiled,
	changedNodes: ReadonlyMap<string, Declared>,
): boolean {
	const replaced = (node: GraphNode | ScopeNode): boolean => {
		const now = changedNodes.get(keyOf(node))
		return now !== undefined && now.id !== node.id
	}
	return (
		compiled.graph.some(replaced) ||
		[...compiled.scopes.values()].some(({ scope }) => replaced(scope))
	)
}
