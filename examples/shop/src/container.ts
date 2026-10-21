import { type ContainerBuilder, type ContainerState, container } from '@doweljs/core'
import { type AppConfig, Config } from './config'
import { CatalogService } from './domain/catalog'
import { NotificationService } from './domain/notifications'
import { Cache, MemoryCache } from './infra/cache'
import { Clock, SystemClock } from './infra/clock'
import { Database, SqlDatabase } from './infra/database'
import { FetchClient, HttpClient } from './infra/http'
import { Mailer, SmtpMailer } from './infra/mail'
import { PaymentGateway, StripeGateway } from './infra/payments'
import { MemoryQueue, Queue } from './infra/queue'
import { ConsoleLogger, Logger, MemoryMetrics, Metrics } from './logging'
import { Checkout } from './request'

/**
 * Infrastructure bindings shared by every environment. Composition functions
 * are generic in the builder state so they apply at any point of a chain.
 */
export const infrastructure = <S extends ContainerState>(b: ContainerBuilder<S>) =>
	b
		.bind(Logger, ConsoleLogger)
		.bind(Metrics, MemoryMetrics)
		.bind(Clock, SystemClock)
		.bind(Database, SqlDatabase)
		.bind(Cache, MemoryCache)
		.bind(Queue, MemoryQueue)

/** Everything the application exposes: the catalog, request handling and background delivery. */
export const application = <S extends ContainerState>(b: ContainerBuilder<S>) =>
	b.provide(CatalogService, Checkout, NotificationService)

/**
 * The production composition, unbuilt. Builders are persistent, so tests and
 * other environments derive from it, overriding what they must.
 */
export function appBuilder(config: AppConfig) {
	return container()
		.with(infrastructure)
		.bind(Config, config)
		.bind(HttpClient, FetchClient)
		.bind(PaymentGateway, StripeGateway)
		.bind(Mailer, SmtpMailer)
		.with(application)
}
