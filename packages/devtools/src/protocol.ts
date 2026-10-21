/**
 * The messages between the devtools server and the client module that runs
 * in every environment, and the shape of what the page reads.
 */

import type { ContainerSnapshot } from '@doweljs/core/hot'

/** Sent by the server to every environment: report your containers. */
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
	readonly containers: readonly ContainerSnapshot[]
}

/**
 * A container as `state.json` reports it. When several clients share an
 * environment (two tabs), their containers' ids are prefixed with the client
 * (`2.1`) to keep them apart.
 */
export interface ReportedContainer extends Omit<ContainerSnapshot, 'id'> {
	readonly id: number | string
}

/** What `state.json` returns: the containers of each environment. */
export type State = Record<string, readonly ReportedContainer[]>
