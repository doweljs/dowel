import { service, slot } from '@doweljs/core'

export interface AppConfig {
	readonly env: 'development' | 'production' | 'test'
	readonly databaseUrl: string
	readonly stripeKey: string
	readonly smtpHost: string
	readonly currency: 'USD' | 'EUR'
}

/** The application configuration. Bound per environment, never constructed by the graph. */
export const Config = slot('Config')<AppConfig>()

export const FeatureFlags = service('FeatureFlags', { config: Config }, ({ config }) => ({
	dynamicPricing: config.env !== 'production',
	emailReceipts: true,
}))
