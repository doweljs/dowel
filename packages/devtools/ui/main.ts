/**
 * The devtools page: polls the static graph and every environment's live
 * containers, and redraws when what is visible changed.
 */

import './style.css'
import type { Graph } from '@doweljs/vite'
import type { ReportedLineage, State } from '../src/protocol.ts'
import { layout } from './layout.ts'
import { buildModel, type Model, viewModel } from './model.ts'
import { detailsHtml, escapeHtml, graphSvg, listHtml, options } from './render.ts'
import { View } from './view.ts'

const POLL_MS = 1500

const element = (id: string): HTMLElement => document.getElementById(id)!
const page = {
	environment: element('environment') as HTMLSelectElement,
	container: element('container') as HTMLSelectElement,
	warnings: element('warnings'),
	list: element('list'),
	canvas: element('canvas'),
	graph: element('graph'),
	crumb: element('crumb'),
	bundle: element('bundle') as HTMLInputElement,
	fit: element('fit'),
	status: element('status'),
	details: element('details'),
}

let graph: Graph = { nodes: [], duplicates: [] }
let state: State = {}
let selectedEnvironment: string | null = null
let selectedContainer: string | null = null
let selectedNode: string | null = null
let bundle = true
let renderedKey = ''
let selectorsKey = ''
const view = new View(page.canvas, page.graph)

function containers(): readonly ReportedLineage[] {
	return selectedEnvironment === null ? [] : (state[selectedEnvironment] ?? [])
}

function selectedSnapshot(): ReportedLineage | null {
	const all = containers()
	return all.find((container) => String(container.id) === selectedContainer) ?? all[0] ?? null
}

/** Rebuilds the selectors only when their options change, so an open dropdown stays open. */
function renderSelectors(): void {
	const environments = Object.keys(state).sort(
		(a, b) => (state[b]?.length ?? 0) - (state[a]?.length ?? 0),
	)
	if (selectedEnvironment === null || !environments.includes(selectedEnvironment)) {
		selectedEnvironment = environments[0] ?? null
	}
	const choices = containers().map((container) => ({
		value: String(container.id),
		label: `app #${container.id} · generation ${container.generation}${container.retiring.length > 0 ? ` · ${container.retiring.length} draining` : ''}${container.failure === null ? '' : ' · update failed'}`,
	}))
	if (selectedContainer === null || !choices.some((choice) => choice.value === selectedContainer)) {
		selectedContainer = choices[0]?.value ?? null
	}
	const key = JSON.stringify([
		environments,
		selectedEnvironment,
		choices,
		selectedContainer,
		graph.duplicates,
	])
	if (key === selectorsKey) return
	selectorsKey = key
	page.environment.innerHTML = options(
		environments.map((environment) => ({ value: environment, label: environment })),
		selectedEnvironment,
		'no environment',
	)
	page.container.innerHTML = options(choices, selectedContainer, 'no app')
	page.warnings.textContent =
		graph.duplicates.length > 0
			? `Duplicate names: ${graph.duplicates.map((duplicate) => duplicate.id).join(', ')}`
			: ''
}

function renderGraph(model: Model): void {
	if (model.nodes.size === 0) {
		page.graph.innerHTML =
			'<div class="empty">No slots or services found yet. Load a page that imports them.</div>'
		return
	}
	const shown = viewModel(model, selectedNode, bundle)
	page.graph.innerHTML = graphSvg(shown, layout(shown), selectedNode)
	if (shown.subgraph && selectedNode !== null) {
		const parents = shown.edges.filter((edge) => edge.to === selectedNode).length
		const children = shown.edges.filter((edge) => edge.from === selectedNode).length
		page.status.textContent = `${parents} parent${parents === 1 ? '' : 's'} · ${children} ${children === 1 ? 'child' : 'children'} · ${model.nodes.size} nodes in all`
		page.crumb.innerHTML = `<a id="crumb-all">all</a><span>›</span><b>${escapeHtml(model.nodes.get(selectedNode)!.name)}</b>`
		element('crumb-all').addEventListener('click', () => select(null))
	} else {
		page.status.textContent = `${model.nodes.size} nodes${shown.hubs.size > 0 ? ` · ${shown.hubs.size} shared inline` : ''}`
		page.crumb.innerHTML = ''
	}
	if (!view.fitted) view.fit()
	view.apply()
}

/** Re-renders only when something visible changed, so panning is never interrupted. */
function render(force = false): void {
	renderSelectors()
	const container = selectedSnapshot()
	const key = JSON.stringify([graph, container, selectedNode, bundle])
	if (!force && key === renderedKey) return
	renderedKey = key
	const model = buildModel(graph, container)
	page.list.innerHTML = listHtml(model, selectedNode)
	for (const item of page.list.querySelectorAll('.item')) {
		item.addEventListener('click', () => select(item.getAttribute('data-id')))
	}
	renderGraph(model)
	page.details.innerHTML = detailsHtml(model, selectedNode)
}

function select(id: string | null): void {
	if (id === selectedNode) return
	selectedNode = id
	view.fitted = false
	render()
}

page.environment.addEventListener('change', () => {
	selectedEnvironment = page.environment.value
	render()
})
page.container.addEventListener('change', () => {
	selectedContainer = page.container.value
	render()
})
page.fit.addEventListener('click', () => view.fit())
page.bundle.addEventListener('change', () => {
	bundle = page.bundle.checked
	view.fitted = false
	render(true)
})
view.listen((target) => {
	const hub = target?.closest('[data-hub]')
	const node = target?.closest('.node')
	if (hub) select(hub.getAttribute('data-hub'))
	else if (node) select(node.getAttribute('data-id'))
	else if (selectedNode !== null) select(null)
})

async function poll(): Promise<void> {
	try {
		// Relative to the page, which is served under the devtools path.
		const [nextGraph, nextState] = await Promise.all([
			fetch('graph.json').then((response) => response.json() as Promise<Graph>),
			fetch('state.json').then((response) => response.json() as Promise<State>),
		])
		if (nextGraph.nodes.length !== graph.nodes.length) view.fitted = false
		graph = nextGraph
		state = nextState
		if (graph.nodes.length === 0) page.status.textContent = 'no nodes'
		render()
	} catch (error) {
		page.status.textContent = `disconnected: ${error}`
	}
	setTimeout(poll, POLL_MS)
}

void poll()
