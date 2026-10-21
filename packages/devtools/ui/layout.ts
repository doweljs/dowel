/** Laying out what gets drawn: node boxes from dagre, and edge paths between them. */

import dagre, { type EdgeLabel, type GraphLabel, type NodeLabel, type Point } from '@dagrejs/dagre'
import type { ViewModel, ViewNode } from './model.ts'

/** A node's box, by its center. */
export interface Box {
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
}

export interface Path {
	/** SVG path data, from the upper node to the lower one. */
	readonly d: string
	/** Whether the edge points up, so its arrow belongs at the start of the path. */
	readonly reversed: boolean
}

export interface Layout {
	readonly width: number
	readonly height: number
	readonly boxes: ReadonlyMap<string, Box>
	/** One per edge of the view model, in order. */
	readonly paths: readonly Path[]
}

const SPACING: GraphLabel = {
	rankdir: 'TB',
	nodesep: 32,
	ranksep: 72,
	edgesep: 16,
	marginx: 24,
	marginy: 24,
}

/** Node sizes: wide enough for the name in monospace and the ambient line in small type. */
const NODE = {
	minWidth: 104,
	nameChar: 7.4,
	namePadding: 48,
	ambientChar: 5.6,
	ambientPadding: 40,
	height: 44,
	heightWithAmbient: 60,
}

/** Ports along a node's edge are at most this far apart, and keep this far from its corners. */
const PORT = { spacing: 18, inset: 14 }

export function layout(view: ViewModel): Layout {
	const g = new dagre.graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel>({ multigraph: true })
	g.setGraph({ ...SPACING })
	g.setDefaultEdgeLabel(() => ({}))
	for (const node of view.nodes.values()) g.setNode(node.id, size(node))
	view.edges.forEach((edge, i) => {
		g.setEdge(edge.from, edge.to, { weight: edge.kind === 'binding' ? 2 : 1 }, String(i))
	})
	dagre.layout(g)

	const boxes = new Map<string, Box>()
	for (const id of view.nodes.keys()) {
		const { x, y, width, height } = g.node(id)
		boxes.set(id, { x: x!, y: y!, width, height })
	}
	const lanes = view.edges.map((edge, i) => g.edge(edge.from, edge.to, String(i)).points ?? [])
	const { width = 0, height = 0 } = g.graph()
	return { width, height, boxes, paths: routes(view, boxes, lanes) }
}

function size(node: ViewNode): NodeLabel {
	const ambient = node.ambient.map((item) => item.name).join(' · ')
	const width = Math.max(
		NODE.minWidth,
		node.name.length * NODE.nameChar + NODE.namePadding,
		ambient.length * NODE.ambientChar + NODE.ambientPadding,
	)
	return { width, height: node.ambient.length > 0 ? NODE.heightWithAmbient : NODE.height }
}

/**
 * Edge geometry. Edges leave from ports spread along the upper node's bottom
 * edge and arrive at ports along the lower node's top edge, so parallel edges
 * never overlap. Between ranks only dagre's lane waypoints are kept; its
 * label midpoints are dropped because they bend adjacent-rank edges for no
 * reason.
 */
function routes(
	view: ViewModel,
	boxes: ReadonlyMap<string, Box>,
	lanes: readonly (readonly Point[])[],
): Path[] {
	const rows = new Set([...boxes.values()].map((box) => Math.round(box.y)))
	const runs = view.edges.map((edge, index) => {
		const reversed = boxes.get(edge.to)!.y < boxes.get(edge.from)!.y
		const upper = reversed ? edge.to : edge.from
		const lower = reversed ? edge.from : edge.to
		return { index, upper, lower, reversed }
	})

	// Ports on each node, ordered by where the other end lies.
	const outgoing = new Map<string, { index: number; x: number }[]>()
	const incoming = new Map<string, { index: number; x: number }[]>()
	for (const run of runs) {
		listOf(outgoing, run.upper).push({ index: run.index, x: boxes.get(run.lower)!.x })
		listOf(incoming, run.lower).push({ index: run.index, x: boxes.get(run.upper)!.x })
	}
	for (const ports of [...outgoing.values(), ...incoming.values()]) ports.sort((a, b) => a.x - b.x)
	const port = (ports: readonly { index: number }[], index: number, box: Box): number => {
		const position = ports.findIndex((item) => item.index === index)
		const spread = Math.min(
			PORT.spacing,
			(box.width - 2 * PORT.inset) / Math.max(1, ports.length - 1),
		)
		return box.x + (position - (ports.length - 1) / 2) * spread
	}

	return runs.map((run) => {
		const upper = boxes.get(run.upper)!
		const lower = boxes.get(run.lower)!
		const start = {
			x: port(outgoing.get(run.upper)!, run.index, upper),
			y: upper.y + upper.height / 2,
		}
		const finish = {
			x: port(incoming.get(run.lower)!, run.index, lower),
			y: lower.y - lower.height / 2,
		}
		// Dagre's points run from the edge's source, which for a reversed edge is the lower node.
		const between = lanes[run.index]!.slice(1, -1).filter((point) => rows.has(Math.round(point.y)))
		const points = [start, ...(run.reversed ? between.reverse() : between), finish]
		return { d: curve(points), reversed: run.reversed }
	})
}

/** A smooth path through points, each step a vertical S-curve. */
function curve(points: readonly Point[]): string {
	let d = `M${points[0]!.x} ${points[0]!.y}`
	for (let k = 1; k < points.length; k++) {
		const a = points[k - 1]!
		const b = points[k]!
		const middle = (a.y + b.y) / 2
		d += ` C${a.x} ${middle},${b.x} ${middle},${b.x} ${b.y}`
	}
	return d
}

function listOf<V>(map: Map<string, V[]>, key: string): V[] {
	let list = map.get(key)
	if (list === undefined) {
		list = []
		map.set(key, list)
	}
	return list
}
