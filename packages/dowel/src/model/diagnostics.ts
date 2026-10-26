/**
 * Compile-time errors. Each is an interface with one descriptive,
 * impossible-to-satisfy property, so the compiler's message names the
 * problem and the nodes involved.
 */

/** The dependencies of a service lie on different scope branches. */
export interface IncomparableScopes<Scopes extends string> {
	readonly 'dowel: these dependencies live on different scope branches': Scopes
}

/** The type of `build` while root-scope slots remain unbound. */
export interface MissingBindings<Slots> {
	readonly 'dowel: bind these slots before build(); each lists what needs it': Slots
}

/** The type of `build` while an execution's inputs are incomplete. */
export interface IncompleteExecutions<Executions> {
	readonly 'dowel: these executions need more inputs; each lists the slots its entry needs': Executions
}

/** The type of `build` while an execution input is also bound at build(). */
export interface InputsBoundAtBuild<Executions> {
	readonly 'dowel: each run supplies these execution inputs, so they cannot be bound at build()': Executions
}

/** `open()` was called without a value for a required scoped slot. */
export interface MissingScopeValues<Slots> {
	readonly 'dowel: supply these scoped slots with bind(); each lists what needs it': Slots
}

/** A binding passed to `open()` must carry a value, not a service. */
export interface ScopeBindingsMustBeValues<Name extends string> {
	readonly 'dowel: bind a value to this slot when opening a container, or bind the service at build()': Name
}

/** A binding passed to `open()` for a multi-binding slot. */
export interface ScopeBindingsForMultiBindings<Name extends string> {
	readonly 'dowel: open() cannot supply multi-binding slots; contribute to them at build()': Name
}

/** A binding passed to `open()` for a slot that lives in another scope. */
export interface ScopeBindingsAtOtherScopes<Name extends string> {
	readonly 'dowel: these slots live in another scope, so opening this one cannot supply them': Name
}

/** A binding passed to `open()` for a slot whose value build() already decides. */
export interface ScopeBindingsBoundAtBuild<Name extends string> {
	readonly 'dowel: these slots are bound at build(), so open() cannot supply them': Name
}

/** A scope named `root`, the name of the container's own scope. */
export interface ReservedScopeName<Name extends string> {
	readonly 'dowel: this scope name is reserved for the container itself': Name
}

/** A declaration named with a widened `string` or a union, which the types cannot tell apart from other nodes. */
export interface IndefiniteName<Names extends string> {
	readonly 'dowel: name each declaration with one string literal': Names
}

/** An execution's entry lives in a scope its runs cannot see. */
export interface EntryNotVisible<Entry extends string, Scope extends string> {
	readonly 'dowel: the entry of an execution must live in its scope or above': {
		readonly entry: Entry
		readonly lives: Scope
	}
}

/**
 * A scope the types cannot pin to one declared scope: one typed `AnyScope`,
 * a union of scopes, or a name that is not a literal. Its lifetime cannot be
 * checked, so a captive dependency would go unseen.
 */
export interface IndefiniteScope<Names extends string> {
	readonly 'dowel: pass one declared scope; the types cannot tell which scope this is': Names
}

/** Slot options typed with neither `scope` nor `many`, such as `{}`, which may hold either at runtime. */
export interface EmptySlotOptions<Name extends string> {
	readonly 'dowel: these slot options name neither scope nor many, so the types cannot tell what they hold; leave them out': Name
}

/** A slot's `many` option may be missing, so the types cannot tell whether it resolves to an array. */
export interface MaybeMany<Name extends string> {
	readonly 'dowel: this slot may or may not be a multi-binding; pass many: true or leave the option out': Name
}

/** A slot's `scope` option may be missing, so the types cannot tell which scope the slot lives in. */
export interface MaybeMissingScope<Name extends string> {
	readonly 'dowel: the scope of this slot may be missing; pass a declared scope or leave the option out': Name
}

/** `get()` was called with a node the container cannot reach. */
export interface NotProvided<Name extends string> {
	readonly 'dowel: this node is not reachable from what the container provides': Name
}

/** `get()` was called with a service only an execution reaches, which runs create on demand. */
export interface CreatedOnDemand<Name extends string> {
	readonly 'dowel: this node is reached only through an execution, so get() cannot return it; provide it to create it with the container': Name
}

/** A node lives in a scope the current container cannot see. */
export interface NotVisible<Name extends string, Scope extends string> {
	readonly 'dowel: this node lives in a deeper or unrelated scope; resolve it from a container opened for': {
		readonly node: Name
		readonly scope: Scope
	}
}

/**
 * The type of `build` while the composition has problems: a slot bound
 * twice, an override that replaces nothing, or a binding or override that
 * makes a node depend on itself.
 */
export interface CompositionIssues<Issues extends string> {
	readonly 'dowel: fix these before build()': Issues
}

/** `provide()` was given an array whose length is unknown, so none of its elements is certain. */
export interface UnknownLengthItems {
	readonly 'dowel: provide a tuple, such as a list written in the call or one declared as const; an array may hold any subset of its elements': true
}

/** A scope that is not a direct child of the current one. */
export interface NotChildScope<Scope extends string, Current extends string> {
	readonly 'dowel: a container opens only the scopes directly below its own; this one is not': {
		readonly scope: Scope
		readonly current: Current
	}
}

/** The explicit scope must be at or below every dependency's scope. */
export interface ScopeAboveDependencies<Scope extends string, Needed extends string> {
	readonly 'dowel: this scope is above a dependency; the service must live in it or below': {
		readonly scope: Scope
		readonly deepestDependency: Needed
	}
}
