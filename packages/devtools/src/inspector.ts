/**
 * Polling every environment for the applications `hot()` keeps there. Each poll sends one
 * numbered inspection request and collects the answers quoting it for a
 * short window; a late answer to an earlier poll is ignored, and a closed
 * tab drops out.
 */

import type { DevEnvironment } from 'vite'
import {
	INSPECT,
	type InspectMessage,
	type ReportedLineage,
	STATE,
	type State,
	type StateMessage,
} from './protocol.ts'

/** The longest a poll waits for environments to answer. */
const WINDOW_MS = 120

/** An answer, and the number of the connection it came on, if any. */
interface Answer {
	readonly client: number | null
	readonly message: StateMessage
}

/** One poll: the answers it collected, by client, and how to end its wait early. */
interface Round {
	readonly answers: Map<string, Answer>
	readonly enough: () => void
}

export class Inspector {
	/** Polls still collecting answers, by request. */
	private readonly rounds = new Map<number, Round>()
	private nextRequest = 0
	/** How many clients answered within the last full window; a poll answers once as many have. */
	private expected = 0
	private readonly clients = new WeakMap<object, number>()
	private nextClient = 1

	constructor(private readonly environments: readonly DevEnvironment[]) {
		for (const environment of environments) {
			environment.hot.on(STATE, (data: StateMessage, client: unknown) => this.receive(data, client))
		}
	}

	/**
	 * Asks every client for its lineages. The answer comes once as many
	 * clients answered as last time, or when the window closes; either way the
	 * window runs to its end, so a tab that opened since is counted next time.
	 */
	async inspect(): Promise<State> {
		const answers = new Map<string, Answer>()
		let enough = (): void => {}
		const early = new Promise<void>((resolve) => {
			enough = resolve
		})
		const request = this.nextRequest++
		this.rounds.set(request, { answers, enough })
		const window = new Promise<void>((resolve) => setTimeout(resolve, WINDOW_MS)).then(() => {
			this.rounds.delete(request)
			this.expected = answers.size
		})
		const message: InspectMessage = { request }
		for (const environment of this.environments) environment.hot.send(INSPECT, message)
		await Promise.race([early, window])
		return byEnvironment(answers.values())
	}

	private receive(data: StateMessage, client: unknown): void {
		const round = this.rounds.get(data.request)
		if (round === undefined) return
		const number = this.numberOf(client)
		const key = number === null ? data.environment : `${data.environment}#${number}`
		round.answers.set(key, { client: number, message: data })
		if (this.expected > 0 && round.answers.size >= this.expected) round.enough()
	}

	/** A stable number for a client's connection, which tells apart clients sharing an environment. */
	private numberOf(client: unknown): number | null {
		if (typeof client !== 'object' || client === null) return null
		let number = this.clients.get(client)
		if (number === undefined) {
			number = this.nextClient++
			this.clients.set(client, number)
		}
		return number
	}
}

/**
 * Groups answers by environment. Lineages are told apart by the client they
 * run in (`2.1`), which stays the same for as long as it is connected.
 */
function byEnvironment(answers: Iterable<Answer>): State {
	const state: Record<string, ReportedLineage[]> = {}
	for (const { client, message } of answers) {
		const lineages = message.lineages.map(
			(lineage): ReportedLineage =>
				client === null ? lineage : { ...lineage, id: `${client}.${lineage.id}` },
		)
		state[message.environment] = [...(state[message.environment] ?? []), ...lineages]
	}
	return state
}
