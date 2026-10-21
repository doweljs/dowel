import { service, slot } from '@doweljs/core'
import { Config } from '../config'
import { HttpClient } from './http'

export interface Charge {
	readonly id: string
	readonly amountCents: number
	readonly status: 'succeeded' | 'declined'
}

export interface PaymentGateway {
	charge(customerId: string, amountCents: number): Promise<Charge>
}

export const PaymentGateway = slot('PaymentGateway')<PaymentGateway>()

export const StripeGateway = service(
	'StripeGateway',
	{ http: HttpClient, config: Config },
	({ http, config }) => ({
		charge: (customerId: string, amountCents: number) =>
			http.post(
				'https://api.stripe.example/charges',
				{ key: config.stripeKey, customerId, amountCents },
				decodeCharge,
			),
	}),
)

/** A charge as the payment provider reports it, checked field by field. */
export function decodeCharge(body: unknown): Charge {
	const { id, amountCents, status } = (
		typeof body === 'object' && body !== null ? body : {}
	) as Record<string, unknown>
	if (
		typeof id !== 'string' ||
		typeof amountCents !== 'number' ||
		(status !== 'succeeded' && status !== 'declined')
	) {
		throw new Error(`The payment provider sent a malformed charge: ${JSON.stringify(body)}`)
	}
	return { id, amountCents, status }
}
