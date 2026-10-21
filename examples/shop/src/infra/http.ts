import { service, slot } from '@doweljs/core'
import { Logger, Metrics } from '../logging'

/** Turns a response body into what a caller expects, or throws saying what is wrong with it. */
export type Decode<T> = (body: unknown) => T

export interface HttpClient {
	/** Posts `body` as JSON. Rejects a response that is not a success, or whose body `decode` rejects. */
	post<T>(url: string, body: unknown, decode: Decode<T>): Promise<T>
}

export const HttpClient = slot('HttpClient')<HttpClient>()

/** Wraps fetch with logging and metrics. */
export const FetchClient = service(
	'FetchClient',
	{ log: Logger, metrics: Metrics },
	({ log, metrics }) => {
		const logger = log.child('http')
		return {
			post: async (url, body, decode) => {
				const started = performance.now()
				logger.info('POST', { url })
				const response = await fetch(url, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
				})
				metrics.timing('http.post', performance.now() - started)
				if (!response.ok) throw new Error(`POST ${url} failed with status ${response.status}.`)
				return decode(await response.json())
			},
		} satisfies HttpClient
	},
)
