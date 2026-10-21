/** What the shop announces for work done later, such as sending receipts. */
export type AppEvent = OrderPaid

export interface OrderPaid {
	readonly kind: 'order.paid'
	readonly orderId: string
	readonly userId: string
}
