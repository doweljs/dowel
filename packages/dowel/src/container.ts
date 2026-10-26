/**
 * The container builder. Builders are persistent: every operation returns a
 * new builder and leaves the original untouched, so a base composition can
 * be shared across tests or environments and extended independently.
 */

import type { Container, ContainerBuilder } from './api.ts'
import { type Composition, compile } from './compile/compile.ts'
import type { Compiled } from './compile/plan.ts'
import { DowelError } from './errors.ts'
import type { EmptyState } from './model/state.ts'
import { declaredNode, implOf, nodeOf, slotNode } from './nodes/coerce.ts'
import { assertImplScope } from './nodes/hierarchy.ts'
import { describe, type ImplNode, type SlotNode } from './nodes/node.ts'
import { RootContainer } from './runtime/containers.ts'

const EMPTY: Composition = {
	roots: [],
	bindings: new Map(),
	contributions: new Map(),
	overrides: new Map(),
}

class Builder {
	constructor(private readonly composition: Composition) {}

	provide(...items: readonly unknown[]): Builder {
		// Copied once per call rather than once per item.
		const roots = [...this.composition.roots]
		const bindings = new Map(this.composition.bindings)
		const contributions = new Map(this.composition.contributions)
		for (const item of items) {
			const node = nodeOf(item, 'a provided item')
			if (node.kind === 'binding') {
				addBinding(bindings, contributions, node.slot, node.impl)
			} else if (node.kind === 'scope') {
				throw new DowelError(
					'INVALID_NODE',
					`${describe(node)} cannot be provided. Provide services, executions, slots or bindings.`,
				)
			} else {
				roots.push(node)
			}
		}
		return new Builder({ ...this.composition, roots, bindings, contributions })
	}

	bind(slot: unknown, impl: unknown): Builder {
		return new Builder(withBinding(this.composition, slotNode(slot), implOf(impl)))
	}

	contribute(slot: unknown, impl: unknown): Builder {
		const target = slotNode(slot)
		if (!target.many) {
			throw new DowelError(
				'INVALID_NODE',
				`Slot '${target.name}' is not a multi-binding. Use bind(), or declare it with slot(name, { many: true }).`,
			)
		}
		return this.bind(slot, impl)
	}

	override(target: unknown, impl: unknown): Builder {
		const node = declaredNode(target, 'an override target')
		if (node.kind === 'execution') {
			throw new DowelError(
				'INVALID_NODE',
				`${describe(node)} cannot be overridden; override its entry.`,
			)
		}
		const replacement = implOf(impl)
		if (replacement.kind === 'service' && replacement.service === node) {
			throw new DowelError('CYCLE', `${describe(node)} cannot override itself.`)
		}
		assertImplScope(node, replacement, 'override')
		const overrides = new Map(this.composition.overrides)
		overrides.set(node, replacement)
		return new Builder({ ...this.composition, overrides })
	}

	with(compose: (builder: this) => unknown): unknown {
		return compose(this)
	}

	/** A field, so a detached `build` still works. */
	readonly build = (): Promise<Container> => {
		let compiled: Compiled
		try {
			compiled = compile(this.composition)
		} catch (error) {
			return Promise.reject(error)
		}
		return RootContainer.create(compiled)
	}
}

function withBinding(composition: Composition, slot: SlotNode, impl: ImplNode): Composition {
	const bindings = new Map(composition.bindings)
	const contributions = new Map(composition.contributions)
	addBinding(bindings, contributions, slot, impl)
	return { ...composition, bindings, contributions }
}

/** Records a binding, or a contribution for a multi-binding slot, in maps the caller owns. */
function addBinding(
	bindings: Map<SlotNode, ImplNode>,
	contributions: Map<SlotNode, readonly ImplNode[]>,
	slot: SlotNode,
	impl: ImplNode,
): void {
	assertImplScope(slot, impl, slot.many ? 'contribution' : 'implementation')
	if (slot.many) {
		const existing = contributions.get(slot) ?? []
		if (
			impl.kind === 'service' &&
			existing.some((e) => e.kind === 'service' && e.service === impl.service)
		) {
			throw new DowelError(
				'DUPLICATE',
				`Service '${impl.service.name}' is already contributed to '${slot.name}'.`,
			)
		}
		contributions.set(slot, [...existing, impl])
		return
	}
	if (bindings.has(slot)) {
		throw new DowelError(
			'DUPLICATE',
			`Slot '${slot.name}' is already bound. Use override() to replace a binding.`,
		)
	}
	bindings.set(slot, impl)
}

/** Start composing a container. */
export function container(): ContainerBuilder<EmptyState> {
	return new Builder(EMPTY) as unknown as ContainerBuilder<EmptyState>
}
