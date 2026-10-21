/**
 * Fakes for the edges of the system, and the production composition with
 * them in place.
 */
import { service } from '@doweljs/core'
import type { AppConfig } from '../src/config'
import { appBuilder } from '../src/container'
import { Clock } from '../src/infra/clock'
import { Database, memoryDatabase } from '../src/infra/database'
import { type Mail, Mailer } from '../src/infra/mail'
import { type Charge, PaymentGateway } from '../src/infra/payments'

export const testConfig: AppConfig = {
	env: 'test',
	databaseUrl: 'memory://test',
	stripeKey: 'sk_test',
	smtpHost: 'localhost',
	currency: 'USD',
}

/** A clock that only moves when the test says so. */
export const FakeClock = service('FakeClock', () => {
	let now = new Date('2026-01-01T12:00:00Z')
	return {
		now: () => now,
		set: (date: Date) => {
			now = date
		},
	}
})

/** Records mail instead of sending it. */
export const FakeMailer = service('FakeMailer', () => {
	const sent: Mail[] = []
	return { sent, send: async (mail: Mail) => void sent.push(mail) }
})

/** Approves every charge, and keeps a record of them. */
export const FakePaymentGateway = service('FakePaymentGateway', () => {
	const charges: Charge[] = []
	return {
		charges,
		charge: async (_customerId: string, amountCents: number): Promise<Charge> => {
			const charge: Charge = { id: `ch_fake_${charges.length}`, amountCents, status: 'succeeded' }
			charges.push(charge)
			return charge
		},
	}
})

/** The same storage as the demo's database, open at once instead of after a connection delay. */
export const FakeDatabase = service('FakeDatabase', () => memoryDatabase())

/**
 * The production graph with in-memory edges. The HTTP client needs no fake:
 * only the real payment gateway reaches it, and unreached bindings never
 * activate.
 */
export function testApp(config: AppConfig = testConfig) {
	return appBuilder(config)
		.override(Clock, FakeClock)
		.override(Database, FakeDatabase)
		.override(PaymentGateway, FakePaymentGateway)
		.override(Mailer, FakeMailer)
}

export const startTestApp = () => testApp().build()

export type TestApp = Awaited<ReturnType<typeof startTestApp>>
