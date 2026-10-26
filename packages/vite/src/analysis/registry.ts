/**
 * The project-wide graph assembled from per-module analyses.
 *
 * Nodes are identified by `kind:name`. Names are unique the way the runtime
 * requires: scopes share one name space, and slots, services and executions
 * share another. Dependency references are resolved through each module's
 * imports and re-exports, so edges cross module boundaries and barrels.
 */

import type { Declaration, ModuleAnalysis, Ref } from './analyze.ts'

export interface GraphEdge {
	readonly key: string
	/** Target node id, or null when the reference could not be resolved statically. */
	readonly target: string | null
	readonly optional: boolean
}

export interface GraphNode {
	readonly id: string
	readonly kind: 'slot' | 'service' | 'scope' | 'execution'
	readonly name: string
	/** The scope's name when known statically, or null when it is inferred at runtime. */
	readonly scope: string | null
	/** For scopes: the parent scope's node id. */
	readonly parent: string | null
	/** Whether a slot is a multi-binding; null when its options cannot be read statically. */
	readonly many: boolean | null
	readonly module: string
	readonly local: string
	/** Offsets of the declaration in the code the plugin received, after earlier transforms. */
	readonly start: number
	readonly end: number
	readonly deps: readonly GraphEdge[]
}

export interface Duplicate {
	/** The name, prefixed with `scope ` for scopes. */
	readonly id: string
	/** Every module declaring it, once per declaration. */
	readonly modules: readonly string[]
}

export interface Graph {
	readonly nodes: readonly GraphNode[]
	readonly duplicates: readonly Duplicate[]
}

interface Entry {
	readonly analysis: ModuleAnalysis
	/** Import and re-export sources to the module ids they resolve to. */
	readonly resolved: ReadonlyMap<string, string>
}

const nodeId = (declaration: Pick<Declaration, 'kind' | 'name'>): string =>
	`${declaration.kind}:${declaration.name}`

/** The runtime's name space for a declaration: scopes apart from slots, services and executions. */
const nameKey = (declaration: Pick<Declaration, 'kind' | 'name'>): string =>
	declaration.kind === 'scope' ? `scope ${declaration.name}` : declaration.name

/** How deep re-export and import chains are followed. */
const MAX_HOPS = 8

export class Registry {
	private readonly modules = new Map<string, Entry>()
	/** Declarations by node id, then by module. */
	private readonly byId = new Map<string, Map<string, Declaration>>()
	/** Declaration counts by name key, then by module. */
	private readonly byName = new Map<string, Map<string, number>>()

	set(id: string, analysis: ModuleAnalysis, resolved: ReadonlyMap<string, string>): void {
		this.delete(id)
		this.modules.set(id, { analysis, resolved })
		for (const declaration of analysis.declarations) {
			index(this.byId, nodeId(declaration)).set(id, declaration)
			const counts = index(this.byName, nameKey(declaration))
			counts.set(id, (counts.get(id) ?? 0) + 1)
		}
	}

	delete(id: string): void {
		const entry = this.modules.get(id)
		if (entry === undefined) return
		this.modules.delete(id)
		for (const declaration of entry.analysis.declarations) {
			unindex(this.byId, nodeId(declaration), id)
			unindex(this.byName, nameKey(declaration), id)
		}
	}

	/** Forgets every module of a deleted file, queries included. */
	deleteFile(file: string): void {
		for (const id of [...this.modules.keys()]) {
			if (id === file || id.startsWith(`${file}?`)) this.delete(id)
		}
	}

	/** Names a module declares that are also declared elsewhere, or more than once in it. */
	duplicatesOf(id: string): Duplicate[] {
		const entry = this.modules.get(id)
		if (entry === undefined) return []
		const keys = new Set(entry.analysis.declarations.map(nameKey))
		return [...keys].flatMap((key) => duplicate(key, this.byName.get(key)))
	}

	graph(): Graph {
		const nodes: GraphNode[] = []
		for (const [module, entry] of this.modules) {
			for (const declaration of entry.analysis.declarations) {
				nodes.push({
					id: nodeId(declaration),
					kind: declaration.kind,
					name: declaration.name,
					scope: this.resolveScope(module, declaration),
					parent:
						declaration.kind === 'scope' && declaration.scopeRef !== null
							? this.resolveRef(module, declaration.scopeRef)
							: null,
					many: declaration.many,
					module,
					local: declaration.local,
					start: declaration.start,
					end: declaration.end,
					deps: declaration.deps.map((dep) => {
						const target = dep.ref === null ? null : this.resolveRef(module, dep.ref)
						return {
							key: dep.key,
							target,
							optional: dep.optional,
						}
					}),
				})
			}
		}
		const duplicates = [...this.byName].flatMap(([key, counts]) => duplicate(key, counts))
		return { nodes, duplicates }
	}

	/**
	 * The scope name of a declaration: literal, or the name of the referenced
	 * scope declaration. An execution lives in the parent of the scope its
	 * runs open, as it does at runtime.
	 */
	private resolveScope(module: string, declaration: Declaration): string | null {
		if (declaration.scope !== null) return declaration.scope
		if (declaration.scopeRef === null) return null
		const id = this.resolveRef(module, declaration.scopeRef)
		const found = id === null ? null : this.find(id)
		if (found === null) return null
		return declaration.kind === 'execution'
			? this.resolveScope(found.module, found.declaration)
			: found.declaration.name
	}

	private find(id: string): { module: string; declaration: Declaration } | null {
		const declarations = this.byId.get(id)
		if (declarations === undefined) return null
		for (const [module, declaration] of declarations) return { module, declaration }
		return null
	}

	/** Resolves a reference in a module to a node id, following imports and re-exports. */
	private resolveRef(module: string, ref: Ref, hops = 0): string | null {
		const entry = this.modules.get(module)
		if (entry === undefined || hops > MAX_HOPS) return null
		const local = entry.analysis.declarations.find((d) => d.local === ref.local)
		if (local !== undefined) return ref.member === null ? nodeId(local) : null
		const imported = entry.analysis.imports.get(ref.local)
		const source = imported === undefined ? undefined : entry.resolved.get(imported.source)
		if (imported === undefined || source === undefined) return null
		if (imported.imported === '*') {
			return ref.member === null ? null : this.resolveExport(source, ref.member, hops + 1)
		}
		return ref.member === null ? this.resolveExport(source, imported.imported, hops + 1) : null
	}

	/** Resolves a name a module exports to a node id. */
	private resolveExport(module: string, name: string, hops: number): string | null {
		const entry = this.modules.get(module)
		if (entry === undefined || hops > MAX_HOPS) return null
		const local = entry.analysis.exports.get(name)
		if (local !== undefined) return this.resolveRef(module, { local, member: null }, hops + 1)
		const reexport = entry.analysis.reexports.get(name)
		if (reexport !== undefined) {
			const source = entry.resolved.get(reexport.source)
			if (source === undefined || reexport.imported === '*') return null
			return this.resolveExport(source, reexport.imported, hops + 1)
		}
		for (const star of entry.analysis.stars) {
			const source = entry.resolved.get(star)
			const found = source === undefined ? null : this.resolveExport(source, name, hops + 1)
			if (found !== null) return found
		}
		return null
	}
}

/**
 * The import and re-export sources a module's graph edges may lead through:
 * those `Registry` follows when it resolves the module's references and
 * exports. The plugin resolves exactly these to module ids.
 */
export function sourcesToResolve(analysis: ModuleAnalysis): Set<string> {
	const sources = new Set<string>(analysis.stars)
	for (const reexport of analysis.reexports.values()) sources.add(reexport.source)
	const locals = new Set<string>(analysis.exports.values())
	for (const declaration of analysis.declarations) {
		for (const ref of [declaration.scopeRef, ...declaration.deps.map((dep) => dep.ref)]) {
			if (ref !== null) locals.add(ref.local)
		}
	}
	for (const local of locals) {
		const imported = analysis.imports.get(local)
		if (imported !== undefined) sources.add(imported.source)
	}
	return sources
}

function index<V>(map: Map<string, Map<string, V>>, key: string): Map<string, V> {
	let inner = map.get(key)
	if (inner === undefined) {
		inner = new Map()
		map.set(key, inner)
	}
	return inner
}

function unindex(map: Map<string, Map<string, unknown>>, key: string, module: string): void {
	const inner = map.get(key)
	inner?.delete(module)
	if (inner?.size === 0) map.delete(key)
}

function duplicate(key: string, counts: ReadonlyMap<string, number> | undefined): Duplicate[] {
	if (counts === undefined) return []
	const modules = [...counts].flatMap(([module, count]) => Array<string>(count).fill(module))
	return modules.length > 1 ? [{ id: key, modules }] : []
}
