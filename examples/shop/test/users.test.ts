import { expect, test } from 'bun:test'
import { UserService } from '../src/domain/users'
import { startTestApp } from './support'

test('users whose emails share a local part get their own ids and records', async () => {
	await using app = await startTestApp()
	const users = app.get(UserService)
	const one = await users.register('alice@one.example', 'Alice One')
	const two = await users.register('alice@two.example', 'Alice Two')
	expect(one.id).not.toBe(two.id)
	expect((await users.find(one.id))?.email).toBe('alice@one.example')
	expect((await users.find(two.id))?.email).toBe('alice@two.example')
})

test('registering an email again returns the user it belongs to', async () => {
	await using app = await startTestApp()
	const users = app.get(UserService)
	const first = await users.register('a@example.com', 'A')
	expect(await users.register('a@example.com', 'Someone else')).toEqual(first)
})
