export type DowelErrorCode =
	/** A root-scope slot reachable from the graph has no binding. */
	| 'UNBOUND_SLOT'
	/** A container was opened, or an execution run, without a value for a required scoped slot. */
	| 'MISSING_SCOPE_VALUE'
	/** A container was opened for a scope that is not a child of the current one. */
	| 'INVALID_SCOPE'
	/** `get()` was called with a node the container cannot reach. */
	| 'NOT_PROVIDED'
	/** `get()` was called with a service only an execution reaches, which runs create on demand. */
	| 'CREATED_ON_DEMAND'
	/** A node was resolved from a container that cannot see it. */
	| 'SCOPE_REQUIRED'
	/**
	 * A scope rule was broken: a service above one of its dependencies,
	 * dependencies on different scope branches, an implementation or override
	 * below the node it stands for, or an execution entry below its scope.
	 */
	| 'CAPTIVE_DEPENDENCY'
	/** The graph contains a cycle, or a node overrides itself. */
	| 'CYCLE'
	/**
	 * Something was declared twice: a slot bound twice, a service contributed
	 * twice, a resource adopted twice, two distinct nodes or scopes sharing a
	 * name, or a slot bound at build() that an execution or open() also supplies.
	 */
	| 'DUPLICATE'
	/** An override targets a node that is not in the graph. */
	| 'UNKNOWN_OVERRIDE'
	/** An async service was resolved before its initialization finished. */
	| 'NOT_READY'
	/** The container has been disposed. */
	| 'DISPOSED'
	/** A value that is not the expected kind of dowel node was passed. */
	| 'INVALID_NODE'
	/** `ctx.use()` received a value without `Symbol.dispose` or `Symbol.asyncDispose`. */
	| 'NOT_DISPOSABLE'
	/** A run's body succeeded but disposing the run failed; thrown as a `DisposalError`. */
	| 'DISPOSAL_FAILED'

/** Every runtime failure dowel raises. Messages name the node as `Kind 'name'`, state the problem, then the remedy. */
export class DowelError extends Error {
	override readonly name = 'DowelError'
	readonly code: DowelErrorCode

	constructor(code: DowelErrorCode, message: string, options?: ErrorOptions) {
		super(message, options)
		this.code = code
	}
}

/** A run's body succeeded with `value`, then disposing the run failed with `cause`. */
export class DisposalError extends DowelError {
	readonly value: unknown

	constructor(message: string, value: unknown, options: ErrorOptions) {
		super('DISPOSAL_FAILED', message, options)
		this.value = value
	}
}

/** Formats a dependency path for error messages: `Users → Mailer → Logger`. */
export function formatPath(path: readonly string[]): string {
	return path.join(' → ')
}

/** The failures an error stands for: its members when it aggregates several, otherwise itself. */
export function errorsOf(error: unknown): unknown[] {
	return error instanceof AggregateError ? error.errors : [error]
}

/** Runs `cleanup` and returns its failures instead of throwing them; none when it succeeded. */
export async function failuresOf(cleanup: () => Promise<void>): Promise<unknown[]> {
	try {
		await cleanup()
		return []
	} catch (error) {
		return errorsOf(error)
	}
}

/** The failure of `what`, with any cleanup failures after it in an `AggregateError`. */
export function withCleanupFailures(
	error: unknown,
	cleanupFailures: readonly unknown[],
	what = 'Construction',
): unknown {
	if (cleanupFailures.length === 0) return error
	return new AggregateError(
		[error, ...cleanupFailures],
		`${what} failed, and ${cleanupFailures.length} cleanup step(s) failed afterwards.`,
	)
}

/** Runs `work`; if it fails, runs `cleanup` first and rejects with the failure plus any cleanup failure. */
export async function withCleanup<T>(
	work: () => Promise<T>,
	cleanup: () => Promise<void>,
	what?: string,
): Promise<T> {
	try {
		return await work()
	} catch (error) {
		throw withCleanupFailures(error, await failuresOf(cleanup), what)
	}
}
