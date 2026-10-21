import { service, slot } from '@doweljs/core'
import { Config } from '../config'
import { Logger } from '../logging'
import type { Tables } from '../schema'

type TableName = keyof Tables

/** Reading a table of records keyed by `id`. */
export interface ReadTable<T> {
	get(id: string): Promise<T | undefined>
	/** The records whose fields equal every field of `where`. */
	find(where?: Partial<T>): Promise<T[]>
}

/** Reading and writing a table inside a transaction. */
export interface Table<T> extends ReadTable<T> {
	/** Rejects a record whose id is taken. */
	insert(record: T): Promise<void>
	/** Rejects an id no record has. */
	update(id: string, patch: Partial<T>): Promise<void>
}

export interface Transaction {
	table<K extends TableName>(name: K): Table<Tables[K]>
}

export interface Database {
	/** Reads a table as last committed; writes of a transaction still running are not seen. */
	table<K extends TableName>(name: K): ReadTable<Tables[K]>
	/**
	 * Runs `work` as a transaction: transactions run one at a time, and what
	 * `work` writes is committed when it succeeds and discarded when it fails.
	 * Only writes to this database are discarded: a payment taken or a message
	 * sent during `work` stays.
	 *
	 * Transactions do not nest: `work` that starts another transaction waits
	 * for itself and never finishes. Code that writes on a caller's behalf
	 * takes the caller's `Transaction` instead, as every write here does.
	 */
	transaction<R>(work: (tx: Transaction) => Promise<R>): Promise<R>
}

export const Database = slot('Database')<Database>()

type Rows = ReadonlyMap<string, { readonly id: string }>

/**
 * The storage behind the demo's database and the tests': tables in memory.
 * A transaction works on a copy of each table it writes, which replaces the
 * committed one when it succeeds.
 */
export function memoryDatabase(): Database {
	let committed = new Map<TableName, Rows>()
	let queue: Promise<unknown> = Promise.resolve()
	return {
		table: (name) => reader(() => committed.get(name)),
		transaction: (work) => {
			const run = async () => {
				const working = new Map(committed)
				const copied = new Set<TableName>()
				const writable = (name: TableName) => {
					if (!copied.has(name)) {
						working.set(name, new Map(working.get(name)))
						copied.add(name)
					}
					return working.get(name) as Map<string, { readonly id: string }>
				}
				const result = await work({
					table: (name) => ({
						...reader(() => working.get(name)),
						insert: async (record) => {
							const rows = writable(name)
							if (rows.has(record.id)) throw new Error(`${name}: the id '${record.id}' is taken.`)
							rows.set(record.id, record)
						},
						update: async (id, patch) => {
							const rows = writable(name)
							const record = rows.get(id)
							if (record === undefined) throw new Error(`${name}: no record has the id '${id}'.`)
							rows.set(id, { ...record, ...patch })
						},
					}),
				})
				committed = working
				return result
			}
			const result = queue.then(run, run)
			queue = result.catch(() => undefined)
			return result
		},
	}
}

function reader<T>(rows: () => Rows | undefined): ReadTable<T> {
	const all = () => [...(rows()?.values() ?? [])] as T[]
	return {
		get: async (id) => rows()?.get(id) as T | undefined,
		find: async (where = {}) =>
			all().filter((record) =>
				Object.entries(where).every(([key, value]) => record[key as keyof T] === value),
			),
	}
}

/** The in-memory storage behind a connection that, like a real driver's, opens asynchronously. */
export const SqlDatabase = service(
	'SqlDatabase',
	{ config: Config, log: Logger },
	async ({ config, log }, ctx) => {
		const logger = log.child('db')
		logger.info('connecting', { url: config.databaseUrl })
		await new Promise((resolve) => setTimeout(resolve, 30))
		ctx.defer(() => logger.info('disconnected'))
		logger.info('connected')
		return memoryDatabase()
	},
)
