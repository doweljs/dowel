/**
 * The `ServiceContext` a factory receives: what the instance owns, the
 * callbacks it defers, the effect it runs while its generation is active,
 * and the signal that tells it to stop.
 */

import type { ServiceContext } from '../api.ts'
import { DowelError } from '../errors.ts'
import { signalOf } from './dispose.ts'
import type { Disposer, InstanceRecord, Store } from './store.ts'

export function contextFor(name: string, record: InstanceRecord, store: Store): ServiceContext {
	// Like AsyncDisposableStack, a disposed context accepts nothing more.
	const assertLive = (method: string): void => {
		if (record.disposed) {
			throw new DowelError(
				'DISPOSED',
				`Service '${name}' has been disposed, so ctx.${method}() can no longer take anything on.`,
			)
		}
	}
	return {
		use: (resource) => {
			assertLive('use')
			const dispose = disposerOf(resource)
			if (dispose === null) {
				throw new DowelError(
					'NOT_DISPOSABLE',
					`Service '${name}' passed a value without Symbol.dispose or Symbol.asyncDispose to ctx.use(). Use ctx.adopt(value, dispose) instead.`,
				)
			}
			own(name, record, resource, dispose)
			return resource
		},
		adopt: (resource, dispose) => {
			assertLive('adopt')
			own(name, record, resource, () => dispose(resource))
			return resource
		},
		defer: (dispose) => {
			assertLive('defer')
			record.cleanups.push({ dispose, resource: null })
		},
		whileActive: (start) => {
			assertLive('whileActive')
			if (!record.constructing) {
				throw new DowelError(
					'INVALID_EFFECT',
					`Service '${name}' called ctx.whileActive() after its factory returned. Register the effect while the factory runs, so that it starts with the generation.`,
				)
			}
			if (store.scope.depth !== 0) {
				throw new DowelError(
					'INVALID_EFFECT',
					`Service '${name}' lives in scope '${store.scope.name}', but only root-scope services run effects with ctx.whileActive(). Start the work from a run instead.`,
				)
			}
			if (record.effect !== null) {
				throw new DowelError(
					'INVALID_EFFECT',
					`Service '${name}' called ctx.whileActive() twice. An instance runs one effect, whose hand-over is matched by the service's name.`,
				)
			}
			const effect = store.generation.add(name, start, () => signalOf(record, store))
			record.effect = effect
			record.cleanups.push({ dispose: () => store.generation.drop(effect), resource: null })
		},
		get signal() {
			return signalOf(record, store)
		},
	}
}

function disposerOf(instance: unknown): Disposer | null {
	if ((typeof instance !== 'object' && typeof instance !== 'function') || instance === null) {
		return null
	}
	const target = instance as Partial<AsyncDisposable & Disposable>
	if (typeof target[Symbol.asyncDispose] === 'function') {
		return () => target[Symbol.asyncDispose]!()
	}
	if (typeof target[Symbol.dispose] === 'function') return () => target[Symbol.dispose]!()
	return null
}

/** Registers a resource with the instance's record, rejecting double ownership anywhere in the container. */
function own(name: string, record: InstanceRecord, resource: unknown, dispose: Disposer): void {
	if ((typeof resource !== 'object' && typeof resource !== 'function') || resource === null) {
		record.cleanups.push({ dispose, resource: null })
		return
	}
	if (record.owned.has(resource)) {
		throw new DowelError(
			'DUPLICATE',
			`Service '${name}' adopted a resource that another service already owns. A resource has one owner; depend on the owning service instead.`,
		)
	}
	record.owned.add(resource)
	record.cleanups.push({ dispose, resource })
}
