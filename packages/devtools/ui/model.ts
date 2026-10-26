/**
 * What the page shows: the static graph merged with the live state of the
 * selected container, and the part of it that gets drawn.
 */

import type { NodeBinding, NodeInfo } from '@doweljs/core'
import type { Graph, GraphEdge, GraphNode } from '@doweljs/vite'
import type { ReportedLineage } from '../src/protocol.ts'

/** A node as static analysis found it, with its instance in the selected container, if any. */
export interface Node {
	readonly id: string
	readonly kind: GraphNode['kind']
	readonly name: string
	readonly scope: string | null
	readonly parent: string | null
	/** Whether a slot is a multi-binding; null while neither the analysis nor a container knows. */
	readonly many: boolean | null
	readonly module: string
	readonly deps: readonly GraphEdge[]
	readonly live: NodeInfo | null
}

export interface Edge {
	readonly from: string
	readonly to: string
	readonly kind: 'dep' | 'optional' | 'binding'
	readonly key: string | null
	readonly label: string
}

export interface Model {
	readonly nodes: ReadonlyMap<string, Node>
	readonly edges: readonly Edge[]
}

/** A dependency shown as a line on its dependent instead of as an edge. */
export interface Ambient {
	readonly id: string
	readonly name: string
	readonly optional: boolean
}

export interface ViewNode extends Node {
	readonly ambient: readonly Ambient[]
}

/** What gets drawn: the whole graph, or a selected node's direct subgraph. */
export interface ViewModel {
	readonly nodes: ReadonlyMap<string, ViewNode>
	readonly edges: readonly Edge[]
	/** Nodes depended on so widely that they are shown on their dependents instead. */
	readonly hubs: ReadonlySet<string>
	readonly subgraph: boolean
}

/** Nodes with at least this many dependents are shown inline on their dependents. */
const HUB_MIN = 3

/** Slots, services and executions share one name space, as they do at runtime. */
const NAMED_KINDS = ['service', 'slot', 'execution'] as const

export function buildModel(graph: Graph, container: ReportedLineage | null): Model {
	const live = new Map<string, NodeInfo>()
	for (const node of container?.nodes ?? []) live.set(`${node.kind}:${node.name}`, node)

	const nodes = new Map<string, Node>()
	for (const node of graph.nodes) {
		const known = live.get(node.id) ?? null
		nodes.set(node.id, {
			id: node.id,
			kind: node.kind,
			name: node.name,
			scope: node.scope,
			parent: node.parent,
			many: node.many ?? known?.many ?? null,
			module: node.module,
			deps: node.deps,
			live: known,
		})
	}
	// Nodes the runtime knows but static analysis did not see (declared dynamically).
	for (const [id, node] of live) {
		if (nodes.has(id)) continue
		nodes.set(id, {
			id,
			kind: node.kind,
			name: node.name,
			scope: node.scope,
			parent: null,
			many: node.many,
			module: '(runtime only)',
			deps: [],
			live: node,
		})
	}

	// The runtime reports dependencies by name; the node the live container knows is the one meant.
	const byName = (name: string): string | null => {
		for (const known of [live, nodes]) {
			for (const kind of NAMED_KINDS) if (known.has(`${kind}:${name}`)) return `${kind}:${name}`
		}
		return null
	}

	const edges: Edge[] = []
	for (const node of nodes.values()) {
		for (const dep of depsOf(node, byName)) {
			const target = dep.target === null ? undefined : nodes.get(dep.target)
			if (target === undefined) continue
			edges.push({
				from: node.id,
				to: target.id,
				kind: dep.optional ? 'optional' : 'dep',
				key: dep.key,
				label: `${node.name}.${dep.key} → ${target.name}`,
			})
		}
		const parent = node.parent === null ? undefined : nodes.get(node.parent)
		if (node.kind === 'scope' && parent !== undefined) {
			edges.push({
				from: node.id,
				to: parent.id,
				kind: 'dep',
				key: 'parent',
				label: `${node.name} opens inside ${parent.name}`,
			})
		}
		for (const service of implementations(node.live?.binding ?? null)) {
			const bound = `service:${service}`
			if (nodes.has(bound) && bound !== node.id) {
				edges.push({
					from: node.id,
					to: bound,
					kind: 'binding',
					key: null,
					label: `${node.name} is bound to ${service}`,
				})
			}
		}
	}
	return { nodes, edges }
}

/** Static edges first; the live container fills in those static analysis could not resolve. */
function depsOf(node: Node, byName: (name: string) => string | null): readonly GraphEdge[] {
	const liveDeps = new Map((node.live?.deps ?? []).map((dep) => [dep.key, dep]))
	const fromLive = (dep: { readonly key: string; readonly name: string }): GraphEdge => ({
		key: dep.key,
		target: byName(dep.name),
		optional: false,
	})
	if (node.deps.length === 0) return [...liveDeps.values()].map(fromLive)
	return node.deps.map((dep) => {
		const known = liveDeps.get(dep.key)
		return dep.target !== null || known === undefined
			? dep
			: { ...fromLive(known), optional: dep.optional }
	})
}

/** The services bound to a node, as the runtime reports its binding. */
function implementations(binding: NodeBinding | null): string[] {
	if (binding?.kind === 'service') return [binding.name]
	if (binding?.kind === 'many') {
		return binding.items.flatMap((item) => (item.kind === 'service' ? [item.name] : []))
	}
	return []
}

/**
 * With a node selected, its direct subgraph: the node, its parents
 * (dependents, and the slot it implements) and its children (dependencies,
 * and the service bound to it). Otherwise the whole graph, with hub
 * dependencies shown on their dependents when `bundle` is on.
 */
export function viewModel(model: Model, selected: string | null, bundle: boolean): ViewModel {
	if (selected !== null && model.nodes.has(selected)) {
		const edges = model.edges.filter((edge) => edge.from === selected || edge.to === selected)
		const visible = new Set([selected, ...edges.flatMap((edge) => [edge.from, edge.to])])
		const nodes = new Map<string, ViewNode>()
		for (const id of visible) nodes.set(id, { ...model.nodes.get(id)!, ambient: [] })
		return { nodes, edges, hubs: new Set(), subgraph: true }
	}
	const hubs = bundle ? hubsOf(model) : new Set<string>()
	const ambient = new Map<string, Ambient[]>()
	const edges: Edge[] = []
	for (const edge of model.edges) {
		if (edge.kind === 'binding' || !hubs.has(edge.to)) {
			edges.push(edge)
			continue
		}
		const list = ambient.get(edge.from) ?? []
		list.push({
			id: edge.to,
			name: model.nodes.get(edge.to)!.name,
			optional: edge.kind === 'optional',
		})
		ambient.set(edge.from, list)
	}
	const nodes = new Map<string, ViewNode>()
	for (const [id, node] of model.nodes) nodes.set(id, { ...node, ambient: ambient.get(id) ?? [] })
	return { nodes, edges, hubs, subgraph: false }
}

function hubsOf(model: Model): Set<string> {
	const dependents = new Map<string, number>()
	for (const edge of model.edges) {
		if (edge.kind !== 'binding') dependents.set(edge.to, (dependents.get(edge.to) ?? 0) + 1)
	}
	return new Set([...dependents].filter(([, count]) => count >= HUB_MIN).map(([id]) => id))
}

export type Status = NonNullable<NodeInfo['status']> | 'none'

export const statusOf = (node: Node): Status => node.live?.status ?? 'none'

/** The scope a node lives in; null while unknown, and for a scope declaration, whose `scope` names its parent. */
export const scopeOf = (node: Node): string | null =>
	node.kind === 'scope' ? null : (node.scope ?? node.live?.scope ?? null)

/** `root` for the container's own scope, `scoped` for any other, or none while the scope is unknown. */
export function scopeClass(node: Node): string {
	const scope = scopeOf(node)
	if (scope === null) return ''
	return scope === 'root' ? 'root' : 'scoped'
}

/** The second line of a node: what kind of thing it is, or the scope it lives in. */
export function lifetimeOf(node: Node): string {
	if (node.kind === 'slot') return node.many === null ? 'slot or many' : node.many ? 'many' : 'slot'
	if (node.kind === 'execution') return 'execution'
	if (node.kind === 'scope') return 'scope'
	return scopeOf(node) ?? 'inferred'
}

export function describeBinding(binding: NodeBinding): string {
	switch (binding.kind) {
		case 'service':
			return binding.name
		case 'many':
			return (
				binding.items.map((item) => (item.kind === 'service' ? item.name : 'value')).join(', ') ||
				'none'
			)
		default:
			return binding.kind
	}
}
