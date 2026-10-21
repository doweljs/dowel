import { describe, expect, test } from 'bun:test'
import type { Product } from '../src/domain/catalog'
import { memoryDatabase } from '../src/infra/database'
import { gate } from './gate'

const tee: Product = { id: 'p_tee', name: 'T-shirt', priceCents: 2500, stock: 10 }
const mug: Product = { id: 'p_mug', name: 'Mug', priceCents: 1200, stock: 2 }

describe('memory database', () => {
	test('finds records by id and by fields', async () => {
		const db = memoryDatabase()
		await db.transaction(async (tx) => {
			await tx.table('products').insert(tee)
			await tx.table('products').insert(mug)
		})
		expect(await db.table('products').get('p_mug')).toEqual(mug)
		expect(await db.table('products').find({ priceCents: 2500 })).toEqual([tee])
		expect(await db.table('products').find()).toEqual([tee, mug])
		expect(await db.table('users').find()).toEqual([])
	})

	test('rejects an id that is taken, and an update of an id no record has', async () => {
		const db = memoryDatabase()
		await db.transaction((tx) => tx.table('products').insert(tee))
		await expect(db.transaction((tx) => tx.table('products').insert(tee))).rejects.toThrow(
			"the id 'p_tee' is taken",
		)
		await expect(
			db.transaction((tx) => tx.table('products').update('p_none', { stock: 1 })),
		).rejects.toThrow("no record has the id 'p_none'")
	})

	test('a failed transaction leaves nothing behind', async () => {
		const db = memoryDatabase()
		await db.transaction((tx) => tx.table('products').insert(tee))
		await expect(
			db.transaction(async (tx) => {
				await tx.table('products').update('p_tee', { stock: 0 })
				await tx.table('products').insert(mug)
				throw new Error('payment declined')
			}),
		).rejects.toThrow('payment declined')
		expect(await db.table('products').find()).toEqual([tee])
	})

	test('a transaction reads its own writes, and nobody else does before it commits', async () => {
		const db = memoryDatabase()
		const written = gate()
		const finish = gate()
		const running = db.transaction(async (tx) => {
			await tx.table('products').insert(tee)
			expect(await tx.table('products').get('p_tee')).toEqual(tee)
			written.open()
			await finish.promise
		})
		await written.promise
		expect(await db.table('products').get('p_tee')).toBeUndefined()
		finish.open()
		await running
		expect(await db.table('products').get('p_tee')).toEqual(tee)
	})

	test('transactions run one at a time, each seeing what the previous committed', async () => {
		const db = memoryDatabase()
		await db.transaction((tx) => tx.table('products').insert(tee))
		const takeOne = () =>
			db.transaction(async (tx) => {
				const product = (await tx.table('products').get('p_tee'))!
				await tx.table('products').update(product.id, { stock: product.stock - 1 })
			})
		await Promise.all([takeOne(), takeOne(), takeOne()])
		expect((await db.table('products').get('p_tee'))?.stock).toBe(7)
	})
})
