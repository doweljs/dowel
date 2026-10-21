import { service, slot } from '@doweljs/core'
import { Config } from '../config'
import { Logger } from '../logging'

export interface Mail {
	readonly to: string
	readonly subject: string
	readonly body: string
}

export interface Mailer {
	send(mail: Mail): Promise<void>
}

export const Mailer = slot('Mailer')<Mailer>()

export const SmtpMailer = service(
	'SmtpMailer',
	{ config: Config, log: Logger },
	({ config, log }) => ({
		send: async (mail: Mail) => {
			log
				.child('smtp')
				.info('sending', { host: config.smtpHost, to: mail.to, subject: mail.subject })
		},
	}),
)
