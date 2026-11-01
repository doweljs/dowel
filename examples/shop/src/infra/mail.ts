import { slot } from '@doweljs/core'
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

export const SmtpMailer = Mailer.implement({ config: Config, log: Logger }, ({ config, log }) => ({
	send: async (mail) => {
		log.child('smtp').info('sending', { host: config.smtpHost, to: mail.to, subject: mail.subject })
	},
}))
