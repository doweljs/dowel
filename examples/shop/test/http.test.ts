import { afterEach, expect, test } from 'bun:test'
import { container } from '@doweljs/core'
import { Config } from '../src/config'
import { FetchClient } from '../src/infra/http'
import { type Charge, decodeCharge } from '../src/infra/payments'
import { ConsoleLogger, Logger, MemoryMetrics, Metrics } from '../src/logging'
import { testConfig } from './support'

const realFetch = globalThis.fetch
afterEach(() => {
	globalThis.fetch = realFetch
})

/** Answers every request with `response`, as a server would. */
function respond(response: Response): void {
	globalThis.fetch = (async () => response) as unknown as typeof fetch
}

const client = () =>
	container()
		.provide(FetchClient)
		.bind(Logger, ConsoleLogger)
		.bind(Metrics, MemoryMetrics)
		.bind(Config, testConfig)
		.build()

test('an unsuccessful response is rejected', async () => {
	await using app = await client()
	respond(new Response('nope', { status: 502 }))
	await expect(app.get(FetchClient).post('https://pay.example', {}, decodeCharge)).rejects.toThrow(
		'failed with status 502',
	)
})

test('a response is decoded at the boundary, and a malformed one rejected', async () => {
	await using app = await client()
	const charge: Charge = { id: 'ch_1', amountCents: 100, status: 'succeeded' }
	respond(Response.json(charge))
	expect(await app.get(FetchClient).post('https://pay.example', {}, decodeCharge)).toEqual(charge)
	respond(Response.json({ id: 'ch_2', status: 'maybe' }))
	await expect(app.get(FetchClient).post('https://pay.example', {}, decodeCharge)).rejects.toThrow(
		'malformed charge',
	)
})
