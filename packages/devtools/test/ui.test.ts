import { describe, expect, test } from 'bun:test'
import type { NodeInfo } from '@doweljs/core'
import type { Graph, GraphNode } from '@doweljs/vite'
import type { ReportedLineage } from '../src/protocol.ts'
import { layout } from '../ui/layout.ts'
import { buildModel, viewModel } from '../ui/model.ts'
import { detailsHtml, escapeHtml, graphSvg, listHtml } from '../ui/render.ts'

/** A statically found node; only what the test cares about needs giving. */
function node(id: string, fields: Partial<GraphNode> = {}): GraphNode {
	const [kind, name] = id.split(':') as [GraphNode['kind'], string]
	return {
		id,
		kind,
		name,
		scope: 'root',
		parent: null,
		many: false,
		module: 'app.ts',
		local: name,
		start: 0,
		end: 0,
		deps: [],
		...fields,
	}
}

/** A node as a live container reports it. */
function live(kind: NodeInfo['kind'], name: string, fields: Partial<NodeInfo> = {}): NodeInfo {
	return {
		kind,
		name,
		scope: 'root',
		many: false,
		deps: [],
		binding: null,
		status: 'ready',
		...fields,
	}
}

function container(nodes: NodeInfo[], id: number | string = 1): ReportedLineage {
	return { id, generation: 1, failure: null, retiring: [], nodes }
}

const graph = (...nodes: GraphNode[]): Graph => ({ nodes, duplicates: [] })

describe('the model', () => {
	test('merges what static analysis found with what the selected container knows', () => {
		const model = buildModel(
			graph(node('service:Users'), node('slot:Logger')),
			container([live('service', 'Users'), live('service', 'Dynamic', { status: 'pending' })]),
		)
		expect(model.nodes.get('service:Users')?.live?.status).toBe('ready')
		expect(model.nodes.get('slot:Logger')?.live).toBeNull()
		// Declared somewhere static analysis cannot see.
		expect(model.nodes.get('service:Dynamic')).toMatchObject({
			module: '(runtime only)',
			live: { status: 'pending' },
		})
	})

	test('static edges come first, and live dependencies fill those it could not resolve', () => {
		const users = node('service:Users', {
			deps: [
				{ key: 'db', target: 'service:Db', optional: false },
				{ key: 'metrics', target: null, optional: true },
			],
		})
		const model = buildModel(
			graph(users, node('service:Db'), node('slot:Metrics')),
			container([
				live('service', 'Users', {
					deps: [
						{ key: 'db', name: 'Db' },
						{ key: 'metrics', name: 'Metrics' },
					],
				}),
				live('slot', 'Metrics'),
			]),
		)
		expect(model.edges.map(({ from, to, kind, key }) => ({ from, to, kind, key }))).toEqual([
			{ from: 'service:Users', to: 'service:Db', kind: 'dep', key: 'db' },
			{ from: 'service:Users', to: 'slot:Metrics', kind: 'optional', key: 'metrics' },
		])
	})

	test('bindings and scope parents become edges', () => {
		const model = buildModel(
			graph(
				node('slot:Logger'),
				node('service:Console'),
				node('slot:Plugins', { many: true }),
				node('service:Cors'),
				node('scope:request', { parent: 'scope:session' }),
				node('scope:session'),
			),
			container([
				live('slot', 'Logger', { binding: { kind: 'service', name: 'Console' } }),
				live('slot', 'Plugins', {
					many: true,
					binding: { kind: 'many', items: [{ kind: 'service', name: 'Cors' }, { kind: 'value' }] },
				}),
			]),
		)
		expect(model.edges.map(({ from, to, kind }) => `${from} ${kind} ${to}`)).toEqual([
			'slot:Logger binding service:Console',
			'slot:Plugins binding service:Cors',
			'scope:request dep scope:session',
		])
	})

	test('switching containers changes the live state, not the graph', () => {
		const declared = graph(node('service:Users'))
		const first = buildModel(
			declared,
			container([live('service', 'Users', { status: 'ready' })], 1),
		)
		const second = buildModel(
			declared,
			container([live('service', 'Users', { status: 'idle' })], 2),
		)
		expect(first.nodes.get('service:Users')?.live?.status).toBe('ready')
		expect(second.nodes.get('service:Users')?.live?.status).toBe('idle')
		expect(buildModel(declared, null).nodes.get('service:Users')?.live).toBeNull()
	})
})

describe('the view', () => {
	// Three services share Logger; Db is used by one.
	const shared = buildModel(
		graph(
			node('slot:Logger'),
			node('service:Db', { deps: [{ key: 'log', target: 'slot:Logger', optional: false }] }),
			node('service:Users', {
				deps: [
					{ key: 'db', target: 'service:Db', optional: false },
					{ key: 'log', target: 'slot:Logger', optional: true },
				],
			}),
			node('service:Mailer', { deps: [{ key: 'log', target: 'slot:Logger', optional: false }] }),
		),
		null,
	)

	test('dependencies with many dependents are shown on each dependent instead of as edges', () => {
		const view = viewModel(shared, null, true)
		expect([...view.hubs]).toEqual(['slot:Logger'])
		expect(view.edges.map(({ from, to }) => `${from} → ${to}`)).toEqual([
			'service:Users → service:Db',
		])
		expect(view.nodes.get('service:Users')?.ambient).toEqual([
			{ id: 'slot:Logger', name: 'Logger', optional: true },
		])
	})

	test('without bundling every edge is drawn', () => {
		const view = viewModel(shared, null, false)
		expect(view.hubs.size).toBe(0)
		expect(view.edges).toHaveLength(4)
	})

	test('a selected node shows its neighbourhood: parents above, children below', () => {
		const view = viewModel(shared, 'service:Db', true)
		expect(view.subgraph).toBe(true)
		expect([...view.nodes.keys()].sort()).toEqual(['service:Db', 'service:Users', 'slot:Logger'])
		// Selected, a hub is just a neighbour.
		expect(view.hubs.size).toBe(0)
	})

	test('a selection that disappeared from the graph shows the whole graph', () => {
		const view = viewModel(shared, 'service:Gone', true)
		expect(view.subgraph).toBe(false)
		expect(view.nodes.size).toBe(4)
	})
})

describe('the markup', () => {
	test('escapes what comes from user code', () => {
		expect(escapeHtml('<b title="x">&</b>')).toBe('&lt;b title=&quot;x&quot;&gt;&amp;&lt;/b&gt;')
		const model = buildModel(graph(node('service:<script>', { module: 'a<b>.ts?v=1' })), null)
		const view = viewModel(model, null, true)
		const svg = graphSvg(view, layout(view), null)
		expect(svg).toContain('&lt;script&gt;')
		expect(svg).not.toContain('<script>')
		// Module ids lose their query, then are escaped.
		expect(listHtml(model, null)).toContain('<h3>a&lt;b&gt;.ts</h3>')
	})

	test('draws one path per edge and one group per node, marking the selection', () => {
		const model = buildModel(
			graph(
				node('service:Db'),
				node('service:Users', { deps: [{ key: 'db', target: 'service:Db', optional: false }] }),
			),
			null,
		)
		const view = viewModel(model, 'service:Users', true)
		const svg = graphSvg(view, layout(view), 'service:Users')
		expect(svg.match(/<path class="edge/g)).toHaveLength(1)
		expect(svg.match(/<g class="node/g)).toHaveLength(2)
		expect(svg).toContain('class="node service root focus"')
	})

	test('details describe the selected node, and say so when nothing is selected', () => {
		const model = buildModel(
			graph(
				node('service:Db'),
				node('service:Users', { deps: [{ key: 'db', target: 'service:Db', optional: false }] }),
			),
			container([live('service', 'Users')]),
		)
		expect(detailsHtml(model, null)).toContain('Select a node.')
		const details = detailsHtml(model, 'service:Users')
		expect(details).toContain('<h2>Users</h2>')
		expect(details).toContain('db → Db')
		expect(detailsHtml(model, 'service:Db')).toContain('<dt>used by</dt><dd>Users</dd>')
	})

	test('a slot of unknown multiplicity says so until a container reports it', () => {
		const unknown = buildModel(graph(node('slot:Mw', { many: null })), null)
		const view = viewModel(unknown, null, false)
		expect(graphSvg(view, layout(view), null)).toContain('slot or many')
		const reported = buildModel(
			graph(node('slot:Mw', { many: null })),
			container([live('slot', 'Mw', { many: true })]),
		)
		expect(reported.nodes.get('slot:Mw')!.many).toBe(true)
	})

	test('a scope declaration shows its parent, not a scope it lives in', () => {
		const model = buildModel(
			graph(
				node('scope:session'),
				node('scope:request', { scope: 'session', parent: 'scope:session' }),
			),
			null,
		)
		const details = detailsHtml(model, 'scope:request')
		expect(details).toContain('<dt>parent</dt><dd>session</dd>')
		expect(details).not.toContain('<dt>scope</dt>')
		expect(listHtml(model, null)).not.toContain('chip')
	})
})
