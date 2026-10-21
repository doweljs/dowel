import { service } from '@doweljs/core'
import { FeatureFlags } from '../config'
import type { OrderPaid } from '../events'
import { Mailer } from '../infra/mail'
import { Queue } from '../infra/queue'
import { Logger } from '../logging'
import { UserService } from './users'

/** Drains the queue, turning events into emails. */
export const NotificationService = service(
	'NotificationService',
	{ queue: Queue, mailer: Mailer, users: UserService, flags: FeatureFlags, log: Logger },
	({ queue, mailer, users, flags, log }) => {
		const sendReceipt = async ({ orderId, userId }: OrderPaid): Promise<void> => {
			if (!flags.emailReceipts) return
			const user = await users.find(userId)
			if (!user) {
				log.warn('receipt for unknown user', { userId })
				return
			}
			await mailer.send({
				to: user.email,
				subject: `Receipt for ${orderId}`,
				body: `Thanks, ${user.name}!`,
			})
		}
		return {
			deliverPending: () =>
				queue.drain(async (event) => {
					switch (event.kind) {
						case 'order.paid':
							return sendReceipt(event)
					}
				}),
		}
	},
)
