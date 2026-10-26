/**
 * The messages between the devtools server and the client module that runs
 * in every environment, and the shape of what the page reads.
 */

import type { LineageSnapshot } from '@doweljs/core/evolve'

/** Sent by the server to every environment: report the applications `hot()` keeps. */
export const INSPECT = 'dowel:inspect'

export interface InspectMessage {
	/** Identifies the request, so that a reply counts only for the poll that asked. */
	readonly request: number
}

/** Sent by each client in reply to {@link INSPECT}. */
export const STATE = 'dowel:state'

export interface StateMessage {
	/** The request this answers. */
	readonly request: number
	readonly environment: string
	readonly lineages: readonly LineageSnapshot[]
}

/**
 * An application `hot()` keeps, as `state.json` reports it. When several
 * clients share an environment (two tabs), their lineages' ids are prefixed
 * with the client (`2.1`) to keep them apart.
 */
export interface ReportedLineage extends Omit<LineageSnapshot, 'id'> {
	readonly id: number | string
}

/** What `state.json` returns: the lineages of each environment. */
export type State = Record<string, readonly ReportedLineage[]>
