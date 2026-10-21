/** Markup for each part of the page. Pure: every function returns HTML or SVG as a string. */

import type { Layout } from './layout.ts'
import {
	describeBinding,
	lifetimeOf,
	type Model,
	type Node,
	scopeClass,
	scopeOf,
	statusOf,
	type ViewModel,
} from './model.ts'

const MARKERS = ['arrow', 'arrow-active', 'arrow-binding']

export function graphSvg(view: ViewModel, layout: Layout, selected: string | null): string {
	const out: string[] = [
		`<svg xmlns="http://www.w3.org/2000/svg" data-width="${layout.width}" data-height="${layout.height}">`,
		`<defs>${MARKERS.map(marker).join('')}</defs>`,
		'<g id="viewport">',
	]
	view.edges.forEach((edge, i) => {
		const path = layout.paths[i]!
		const classes = classNames(
			'edge',
			edge.kind,
			view.subgraph && 'active',
			path.reversed && 'reversed',
		)
		out.push(
			`<path class="${classes}" d="${path.d}"><title>${escapeHtml(edge.label)}</title></path>`,
		)
	})
	for (const node of view.nodes.values()) {
		const box = layout.boxes.get(node.id)!
		const hub = view.hubs.has(node.id)
		const classes = classNames(
			'node',
			node.kind,
			scopeClass(node),
			selected === node.id && 'focus',
			hub && 'hub',
		)
		const left = box.x - box.width / 2
		const top = box.y - box.height / 2
		out.push(
			`<g class="${classes}" data-id="${escapeHtml(node.id)}" transform="translate(${left},${top})">`,
		)
		out.push(`<rect rx="8" width="${box.width}" height="${box.height}" />`)
		out.push(`<circle class="status ${statusOf(node)}" cx="14" cy="16" r="4" />`)
		out.push(`<text x="26" y="20">${escapeHtml(node.name)}</text>`)
		out.push(
			`<text class="meta" x="26" y="35">${escapeHtml(lifetimeOf(node))}${hub ? ' · shared' : ''}</text>`,
		)
		if (node.ambient.length > 0) {
			const items = node.ambient.map(
				(item) =>
					`<tspan data-hub="${escapeHtml(item.id)}" class="${item.optional ? 'optional' : ''}">${escapeHtml(item.name)}</tspan>`,
			)
			out.push(`<text class="meta ambient" x="14" y="51">↳ ${items.join(' · ')}</text>`)
		}
		out.push('</g>')
	}
	out.push('</g></svg>')
	return out.join('')
}

function marker(id: string): string {
	return `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" /></marker>`
}

/** The nodes grouped by module, for the side list. */
export function listHtml(model: Model, selected: string | null): string {
	const byModule = new Map<string, Node[]>()
	for (const node of model.nodes.values()) {
		const list = byModule.get(node.module) ?? []
		list.push(node)
		byModule.set(node.module, list)
	}
	const out: string[] = []
	for (const module of [...byModule.keys()].sort()) {
		out.push(`<div class="module"><h3>${escapeHtml(withoutQuery(module))}</h3>`)
		for (const node of byModule.get(module)!) {
			const scope = scopeOf(node)
			const chip =
				scope === null ? '' : `<span class="chip ${scopeClass(node)}">${escapeHtml(scope)}</span>`
			out.push(
				`<div class="${classNames('item', selected === node.id && 'active')}" data-id="${escapeHtml(node.id)}">` +
					`<span class="dot ${statusOf(node)}"></span><span>${escapeHtml(node.name)}</span>${chip}</div>`,
			)
		}
		out.push('</div>')
	}
	return out.join('') || '<div class="empty">Nothing yet.</div>'
}

/** What the details panel says about the selected node. */
export function detailsHtml(model: Model, selected: string | null): string {
	const node = selected === null ? undefined : model.nodes.get(selected)
	if (node === undefined) return '<div class="empty">Select a node.</div>'
	const { live } = node
	const name = (id: string): string => model.nodes.get(id)!.name
	const own = model.edges.filter((edge) => edge.kind !== 'binding')
	const dependents = own
		.filter((edge) => edge.to === node.id)
		.map((edge) => escapeHtml(name(edge.from)))
	const deps = own
		.filter((edge) => edge.from === node.id)
		.map(
			(edge) =>
				`${escapeHtml(edge.key ?? '')} → ${escapeHtml(name(edge.to))}${edge.kind === 'optional' ? ' (optional)' : ''}`,
		)
	const rows: [string, string][] = [
		['kind', escapeHtml(node.kind)],
		['module', escapeHtml(withoutQuery(node.module))],
		node.kind === 'scope'
			? ['parent', escapeHtml(node.scope ?? 'unknown')]
			: ['scope', escapeHtml(scopeOf(node) ?? 'inferred')],
		['status', live === null ? 'no live container' : escapeHtml(live.status ?? 'not cached')],
		['binding', live?.binding ? escapeHtml(describeBinding(live.binding)) : '—'],
		['depends on', deps.join('<br>') || '—'],
		['used by', dependents.join(', ') || '—'],
	]
	return `<h2>${escapeHtml(node.name)}</h2><dl>${rows.map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`).join('')}</dl>`
}

export function options(
	values: readonly { value: string; label: string }[],
	selected: string | null,
	empty: string,
): string {
	if (values.length === 0) return `<option>${escapeHtml(empty)}</option>`
	return values
		.map(
			({ value, label }) =>
				`<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`,
		)
		.join('')
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"]/g, (char) => ENTITIES[char]!)
}

/** Module ids may carry a query (`?v=…`) that means nothing to a reader. */
function withoutQuery(module: string): string {
	return module.replace(/\?.*$/, '')
}

function classNames(...names: (string | false)[]): string {
	return names.filter(Boolean).join(' ')
}
