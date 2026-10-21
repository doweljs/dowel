/**
 * Static analysis of a module's dowel declarations.
 *
 * Only top-level `const X = service(...)` / `slot(...)()` declarations are
 * recognized. That is deliberate: a dependency graph declared at the top
 * level of a module is what makes hot replacement and devtools possible without running
 * the code.
 */

import type { ESTree } from 'vite'
import { parseSync } from 'vite'

/** A reference a static graph can follow: a local identifier, or a member of a namespace import (`ns.Name`). */
export interface Ref {
	readonly local: string
	readonly member: string | null
}

interface DepRef {
	readonly key: string
	/** What the dependency refers to; `null` when the edge is kept but cannot be resolved statically. */
	readonly ref: Ref | null
	readonly optional: boolean
}

export interface Declaration {
	readonly local: string
	readonly kind: 'slot' | 'service' | 'scope' | 'execution'
	readonly name: string
	/** The scope name when it is known statically: `root` for a slot or scope declared without one. */
	readonly scope: string | null
	/** A slot's or service's `scope` option, or a scope's parent. */
	readonly scopeRef: Ref | null
	/** Whether a slot is a multi-binding; null when its options cannot be read. */
	readonly many: boolean | null
	readonly deps: readonly DepRef[]
	/** Offsets of the declaring call in the code this plugin received, after earlier transforms. */
	readonly start: number
	readonly end: number
}

interface ImportRef {
	readonly source: string
	/** Exported name in the source module (`default` for default imports). */
	readonly imported: string
}

export interface ModuleAnalysis {
	readonly declarations: readonly Declaration[]
	/** Local name to the import it comes from, for resolving dependency references. */
	readonly imports: ReadonlyMap<string, ImportRef>
	/** Exported name to local name. */
	readonly exports: ReadonlyMap<string, string>
	/** Exported name to what it re-exports: `export { Db } from '../db'`, `export * as ns from`. */
	readonly reexports: ReadonlyMap<string, ImportRef>
	/** Sources of `export * from` statements, searched in order for names not exported otherwise. */
	readonly stars: readonly string[]
	/**
	 * True when every export is a dowel declaration, so the module can accept
	 * its own hot updates without leaving importers with stale values.
	 */
	readonly selfContained: boolean
	/** True when the module calls `container()`, which makes it an app root. */
	readonly buildsContainer: boolean
}

type Node = ESTree.Node

/** The names a module may import from dowel, mapped from their local aliases. */
type DowelImports = ReadonlyMap<string, DowelExport>

const DOWEL_EXPORTS = ['service', 'slot', 'optional', 'container', 'scope', 'execution'] as const
type DowelExport = (typeof DOWEL_EXPORTS)[number]

const isDowelExport = (name: string): name is DowelExport =>
	(DOWEL_EXPORTS as readonly string[]).includes(name)

/** Where a declaration lives: a statically known scope name, or a reference to a scope. */
type Placement = Pick<Declaration, 'scope' | 'scopeRef'>

const REEXPORT = /\bexport\s*(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\b/

/** Cheap pre-check so most modules never reach the parser: they neither use dowel nor re-export. */
export function mayDeclare(code: string): boolean {
	return code.includes('@doweljs/core') || REEXPORT.test(code)
}

export function analyze(id: string, code: string): ModuleAnalysis | null {
	const { program, errors } = parseSync(id, code)
	if (errors.length > 0) return null

	const dowel = collectDowelImports(program)
	const declarations: Declaration[] = []
	const imports = new Map<string, ImportRef>()
	const exports = new Map<string, string>()
	const reexports = new Map<string, ImportRef>()
	const stars: string[] = []
	// Whether the module exports anything besides its dowel declarations.
	let mixed = false

	for (const statement of program.body) {
		switch (statement.type) {
			case 'ImportDeclaration':
				for (const specifier of statement.specifiers) {
					const imported =
						specifier.type === 'ImportSpecifier'
							? moduleExportName(specifier.imported)
							: specifier.type === 'ImportDefaultSpecifier'
								? 'default'
								: '*'
					imports.set(specifier.local.name, { source: statement.source.value, imported })
				}
				break
			case 'VariableDeclaration':
				declarations.push(...declarationsOf(statement, dowel))
				break
			case 'ExportNamedDeclaration': {
				const { declaration } = statement
				if (declaration?.type === 'VariableDeclaration') {
					const found = declarationsOf(declaration, dowel)
					declarations.push(...found)
					for (const declarator of declaration.declarations) {
						for (const name of boundNames(declarator.id)) {
							exports.set(name, name)
							if (!found.some((d) => d.local === name)) mixed = true
						}
					}
				} else if (declaration !== null) {
					mixed = true
				} else if (statement.source !== null) {
					mixed = true
					for (const specifier of statement.specifiers) {
						reexports.set(moduleExportName(specifier.exported), {
							source: statement.source.value,
							imported: moduleExportName(specifier.local),
						})
					}
				} else {
					for (const specifier of statement.specifiers) {
						exports.set(moduleExportName(specifier.exported), moduleExportName(specifier.local))
					}
				}
				break
			}
			case 'ExportDefaultDeclaration':
				if (statement.declaration.type === 'Identifier') {
					exports.set('default', statement.declaration.name)
				} else {
					mixed = true
				}
				break
			case 'ExportAllDeclaration':
				mixed = true
				if (statement.exported === null) stars.push(statement.source.value)
				else {
					reexports.set(moduleExportName(statement.exported), {
						source: statement.source.value,
						imported: '*',
					})
				}
				break
			default:
				break
		}
	}

	if (dowel.size === 0 && reexports.size === 0 && stars.length === 0) return null

	const locals = new Set(declarations.map((d) => d.local))
	for (const local of exports.values()) if (!locals.has(local)) mixed = true

	const containerLocal = [...dowel].find(([, name]) => name === 'container')?.[0]
	const buildsContainer = containerLocal !== undefined && callsIdentifier(program, containerLocal)

	return {
		declarations,
		imports,
		exports,
		reexports,
		stars,
		selfContained: !mixed && !buildsContainer,
		buildsContainer,
	}
}

/** `Name` or `ns.Name`, the references a static graph can follow. */
function refOf(node: Node): Ref | null {
	const value = unwrap(node)
	if (value.type === 'Identifier') return { local: value.name, member: null }
	if (
		value.type === 'MemberExpression' &&
		!value.computed &&
		value.object.type === 'Identifier' &&
		value.property.type === 'Identifier'
	) {
		return { local: value.object.name, member: value.property.name }
	}
	return null
}

/**
 * The properties of an options object literal by key: empty when there are
 * no options, null when the analysis cannot read all of them (not a literal,
 * or a literal with spread or computed properties).
 */
function optionsOf(node: Node | undefined): Map<string, Node> | null {
	if (node === undefined) return new Map()
	const options = unwrap(node)
	if (options.type !== 'ObjectExpression') return null
	const properties = new Map<string, Node>()
	for (const property of options.properties) {
		if (property.type !== 'Property' || property.computed) return null
		const key = propertyKey(property.key)
		if (key === null) return null
		properties.set(key, unwrap(property.value))
	}
	return properties
}

/** `true` or `false` when the option is absent or a boolean literal; null when it cannot be read. */
function literalFlag(node: Node | undefined): boolean | null {
	if (node === undefined) return false
	return node.type === 'Literal' && typeof node.value === 'boolean' ? node.value : null
}

/** A scope argument: absent (the default), a reference to resolve, or an expression that cannot be followed. */
function scopeArgument(node: Node | undefined, fallback: string | null): Placement {
	if (node === undefined) return { scope: fallback, scopeRef: null }
	return { scope: null, scopeRef: refOf(node) }
}

function collectDowelImports(program: ESTree.Program): DowelImports {
	const result = new Map<string, DowelExport>()
	for (const statement of program.body) {
		if (statement.type !== 'ImportDeclaration' || statement.source.value !== '@doweljs/core')
			continue
		for (const specifier of statement.specifiers) {
			if (specifier.type !== 'ImportSpecifier') continue
			const imported = moduleExportName(specifier.imported)
			if (isDowelExport(imported)) result.set(specifier.local.name, imported)
		}
	}
	return result
}

function declarationsOf(statement: ESTree.VariableDeclaration, dowel: DowelImports): Declaration[] {
	const found: Declaration[] = []
	for (const declarator of statement.declarations) {
		if (declarator.id.type !== 'Identifier' || declarator.init === null) continue
		const init = unwrap(declarator.init)
		if (init.type !== 'CallExpression') continue
		const declaration =
			parseService(declarator.id.name, init, dowel) ??
			parseSlot(declarator.id.name, init, dowel) ??
			parseScope(declarator.id.name, init, dowel) ??
			parseExecution(declarator.id.name, init, dowel)
		if (declaration !== null) found.push(declaration)
	}
	return found
}

/** `service('Name', deps?, factory, options?)` */
function parseService(
	local: string,
	call: ESTree.CallExpression,
	dowel: DowelImports,
): Declaration | null {
	if (call.callee.type !== 'Identifier' || dowel.get(call.callee.name) !== 'service') return null
	const [nameArg, second, third, fourth] = call.arguments
	const name = stringValue(nameArg)
	if (name === null) return null
	const hasDeps = second?.type === 'ObjectExpression'
	const options = hasDeps ? fourth : third
	const deps: DepRef[] = []
	if (hasDeps) {
		for (const property of second.properties) {
			if (property.type !== 'Property' || property.computed) continue
			const key = propertyKey(property.key)
			if (key === null) continue
			const value = unwrap(property.value)
			const isOptional =
				value.type === 'CallExpression' &&
				value.callee.type === 'Identifier' &&
				dowel.get(value.callee.name) === 'optional'
			const target = isOptional ? value.arguments[0] : value
			deps.push({
				key,
				ref: target === undefined || target.type === 'SpreadElement' ? null : refOf(target),
				optional: isOptional,
			})
		}
	}
	return {
		local,
		kind: 'service',
		name,
		...scopeArgument(optionsOf(options)?.get('scope'), null),
		many: false,
		deps,
		start: call.start,
		end: call.end,
	}
}

/** `slot('Name', options?)()` */
function parseSlot(
	local: string,
	call: ESTree.CallExpression,
	dowel: DowelImports,
): Declaration | null {
	const inner = unwrap(call.callee)
	if (inner.type !== 'CallExpression') return null
	if (inner.callee.type !== 'Identifier' || dowel.get(inner.callee.name) !== 'slot') return null
	const [nameArg, optionsArg] = inner.arguments
	const name = stringValue(nameArg)
	if (name === null) return null
	const options = optionsOf(optionsArg)
	return {
		local,
		kind: 'slot',
		name,
		// Options the analysis cannot read leave the scope unknown.
		...(options === null
			? { scope: null, scopeRef: null }
			: scopeArgument(options.get('scope'), 'root')),
		many: options === null ? null : literalFlag(options.get('many')),
		deps: [],
		start: call.start,
		end: call.end,
	}
}

/** `scope('name', Parent?)` */
function parseScope(
	local: string,
	call: ESTree.CallExpression,
	dowel: DowelImports,
): Declaration | null {
	if (call.callee.type !== 'Identifier' || dowel.get(call.callee.name) !== 'scope') return null
	const name = stringValue(call.arguments[0])
	if (name === null) return null
	const parent = call.arguments[1]
	return {
		local,
		kind: 'scope',
		name,
		...scopeArgument(parent?.type === 'SpreadElement' ? undefined : parent, 'root'),
		many: false,
		deps: [],
		start: call.start,
		end: call.end,
	}
}

/** `execution('Name', { scope: S, entry: E, inputs: { key: Slot } })` */
function parseExecution(
	local: string,
	call: ESTree.CallExpression,
	dowel: DowelImports,
): Declaration | null {
	if (call.callee.type !== 'Identifier' || dowel.get(call.callee.name) !== 'execution') return null
	const name = stringValue(call.arguments[0])
	if (name === null) return null
	// Options it cannot read still declare the execution; its scope and dependencies stay unknown.
	const options = optionsOf(call.arguments[1]) ?? new Map<string, Node>()
	const scope = options.get('scope')
	const entry = options.get('entry')
	const inputs = options.get('inputs')
	const deps: DepRef[] = []
	if (entry !== undefined) deps.push({ key: 'entry', ref: refOf(entry), optional: false })
	// Keyed as at runtime, by the key each run passes the input's value under.
	for (const [key, input] of optionsOf(inputs) ?? []) {
		deps.push({ key, ref: refOf(input), optional: false })
	}
	return {
		local,
		kind: 'execution',
		name,
		// Known once its scope reference resolves: the parent of the scope its runs open containers for.
		scope: null,
		scopeRef: scope === undefined ? null : refOf(scope),
		many: false,
		deps,
		start: call.start,
		end: call.end,
	}
}

/** Strips TypeScript wrappers that may survive transpilation, such as `satisfies`. */
function unwrap(node: Node): Node {
	let current = node
	for (;;) {
		switch (current.type) {
			case 'ParenthesizedExpression':
			case 'TSAsExpression':
			case 'TSSatisfiesExpression':
			case 'TSNonNullExpression':
			case 'TSTypeAssertion':
				current = current.expression
				continue
			default:
				return current
		}
	}
}

function stringValue(node: Node | undefined): string | null {
	if (node === undefined) return null
	const value = unwrap(node)
	if (value.type === 'Literal' && typeof value.value === 'string') return value.value
	if (value.type === 'TemplateLiteral' && value.expressions.length === 0) {
		return value.quasis[0]?.value.cooked ?? null
	}
	return null
}

function propertyKey(key: Node): string | null {
	if (key.type === 'Identifier') return key.name
	if (key.type === 'Literal' && typeof key.value === 'string') return key.value
	return null
}

function moduleExportName(node: ESTree.ModuleExportName): string {
	return node.type === 'Identifier' ? node.name : String(node.value)
}

function boundNames(pattern: ESTree.BindingPattern): string[] {
	switch (pattern.type) {
		case 'Identifier':
			return [pattern.name]
		case 'ObjectPattern':
			return pattern.properties.flatMap((property) =>
				property.type === 'RestElement'
					? boundNames(property.argument)
					: boundNames(property.value),
			)
		case 'ArrayPattern':
			return pattern.elements.flatMap((element) =>
				element === null
					? []
					: element.type === 'RestElement'
						? boundNames(element.argument)
						: boundNames(element),
			)
		case 'AssignmentPattern':
			return boundNames(pattern.left)
		default:
			return []
	}
}

/** Whether any call expression in the tree calls the given identifier. */
function callsIdentifier(root: Node, name: string): boolean {
	const stack: unknown[] = [root]
	while (stack.length > 0) {
		const current = stack.pop()
		if (typeof current !== 'object' || current === null) continue
		if (Array.isArray(current)) {
			stack.push(...current)
			continue
		}
		const node = current as Node
		if (
			node.type === 'CallExpression' &&
			node.callee.type === 'Identifier' &&
			node.callee.name === name
		) {
			return true
		}
		for (const [key, value] of Object.entries(node)) {
			if (key !== 'parent' && typeof value === 'object' && value !== null) stack.push(value)
		}
	}
	return false
}
