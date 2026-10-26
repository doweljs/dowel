import { describe, expect, test } from 'bun:test'
import { analyze } from '../src/analysis/analyze.ts'
import { Registry } from '../src/analysis/registry.ts'

describe('analyze', () => {
	test('extracts services, slots, dependencies and options', () => {
		const result = analyze(
			'/app/users.ts',
			`import { scope, service, slot, optional } from '@doweljs/core'
import { Db } from './db'
export const Logger = slot('Logger')()
const PerRequest = scope('request')
export const Request = slot('Request', { scope: PerRequest })()
export const Users = service('Users', { db: Db, log: Logger, metrics: optional(Metrics) }, ({ db }) => db)
const Internal = service('Internal', () => 1)
export { Internal as Hidden }
`,
		)
		expect(result).not.toBeNull()
		const byLocal = new Map(result!.declarations.map((d) => [d.local, d]))
		expect(byLocal.get('Logger')).toMatchObject({
			kind: 'slot',
			name: 'Logger',
			scope: 'root',
			many: false,
		})
		expect(byLocal.get('Request')).toMatchObject({
			kind: 'slot',
			name: 'Request',
			scopeRef: { local: 'PerRequest', member: null },
		})
		expect(byLocal.get('Users')).toMatchObject({
			kind: 'service',
			name: 'Users',
			deps: [
				{ key: 'db', ref: { local: 'Db', member: null }, optional: false },
				{ key: 'log', ref: { local: 'Logger', member: null }, optional: false },
				{ key: 'metrics', ref: { local: 'Metrics', member: null }, optional: true },
			],
		})
		expect(byLocal.get('Internal')).toMatchObject({ kind: 'service', scope: null })
		expect(result!.imports.get('Db')).toEqual({ source: './db', imported: 'Db' })
		expect(result!.exports.get('Hidden')).toBe('Internal')
	})

	test('extracts scopes and executions', () => {
		const result = analyze(
			'/app/jobs.ts',
			`import { execution, scope, service, slot } from '@doweljs/core'
export const Job = scope('job')
export const JobInput = slot('JobInput', { scope: Job })()
export const Runner = service('Runner', { input: JobInput }, (d) => d, { scope: Job })
export const RunJob = execution('RunJob', { scope: Job, entry: Runner, inputs: { input: JobInput } })
`,
		)
		const byLocal = new Map(result!.declarations.map((d) => [d.local, d]))
		expect(byLocal.get('Job')).toMatchObject({ kind: 'scope', name: 'job', scopeRef: null })
		expect(byLocal.get('Runner')).toMatchObject({
			kind: 'service',
			scopeRef: { local: 'Job', member: null },
		})
		expect(byLocal.get('RunJob')).toMatchObject({
			kind: 'execution',
			name: 'RunJob',
			scopeRef: { local: 'Job', member: null },
			deps: [
				{ key: 'entry', ref: { local: 'Runner', member: null }, optional: false },
				{ key: 'input', ref: { local: 'JobInput', member: null }, optional: false },
			],
		})
	})

	test('follows import aliases of dowel exports', () => {
		const result = analyze(
			'/app/a.ts',
			`import { service as svc, slot as t } from '@doweljs/core'
export const A = svc('A', () => 1)
export const T = t('T', { many: true })()
export const notANode = service('X', () => 1)
`,
		)
		expect(result!.declarations.map((d) => d.name)).toEqual(['A', 'T'])
	})

	test('ignores modules that do not import dowel', () => {
		expect(
			analyze('/app/x.ts', `export const service = (a) => a; export const A = service('A')`),
		).toBeNull()
	})
})

describe('analyze scopes and multi-bindings', () => {
	test('extracts scope declarations and slot scopes', () => {
		const result = analyze(
			'/app/scopes.ts',
			`import { scope, slot, service } from '@doweljs/core'
export const Session = scope('session')
export const Request = scope('request', Session)
export const Req = slot('Req', { scope: Request })<{ url: string }>()
export const Plugins = slot('Plugins', { many: true })<() => void>()
export const Uow = service('Uow', () => 1, { scope: Request })
`,
		)
		const byLocal = new Map(result!.declarations.map((d) => [d.local, d]))
		expect(byLocal.get('Session')).toMatchObject({
			kind: 'scope',
			name: 'session',
			scope: 'root',
			scopeRef: null,
		})
		expect(byLocal.get('Request')).toMatchObject({
			kind: 'scope',
			name: 'request',
			scope: null,
			scopeRef: { local: 'Session', member: null },
		})
		expect(byLocal.get('Req')).toMatchObject({
			kind: 'slot',
			scope: null,
			scopeRef: { local: 'Request', member: null },
			many: false,
		})
		expect(byLocal.get('Plugins')).toMatchObject({ kind: 'slot', scope: 'root', many: true })
		expect(byLocal.get('Uow')).toMatchObject({
			kind: 'service',
			scopeRef: { local: 'Request', member: null },
		})
	})
})

describe('Registry', () => {
	test('places an execution at its parent scope and keys inputs as the runner takes them', () => {
		const registry = new Registry()
		const scopes = analyze(
			'/app/scopes.ts',
			`import { scope, slot } from '@doweljs/core'
export const Job = scope('job')
export const Step = scope('step', Job)
export const StepInput = slot('StepInput', { scope: Step })()
`,
		)!
		const jobs = analyze(
			'/app/jobs.ts',
			`import { execution, service } from '@doweljs/core'
import { Step, StepInput as In } from './scopes'
export const Runner = service('Runner', { input: In }, (d) => d)
export const RunStep = execution('RunStep', { scope: Step, entry: Runner, inputs: { step: In } })
`,
		)!
		registry.set('/app/scopes.ts', scopes, new Map())
		registry.set('/app/jobs.ts', jobs, new Map([['./scopes', '/app/scopes.ts']]))
		const node = registry.graph().nodes.find((n) => n.id === 'execution:RunStep')
		expect(node).toMatchObject({
			scope: 'job',
			deps: [
				{ key: 'entry', target: 'service:Runner' },
				{ key: 'step', target: 'slot:StepInput' },
			],
		})
	})

	test('follows re-exports, barrels and namespace imports', () => {
		const registry = new Registry()
		registry.set(
			'/app/db.ts',
			analyze(
				'/app/db.ts',
				`import { slot } from '@doweljs/core'\nexport const Db = slot('Db')()\n`,
			)!,
			new Map(),
		)
		const barrel = analyze('/app/index.ts', `export { Db } from './db'\nexport * from './more'\n`)
		expect(barrel).not.toBeNull()
		registry.set('/app/index.ts', barrel!, new Map([['./db', '/app/db.ts']]))
		registry.set(
			'/app/users.ts',
			analyze(
				'/app/users.ts',
				`import { service, optional } from '@doweljs/core'
import { Db } from './index'
import * as slots from './db'
export const Users = service('Users', { db: Db, again: optional(slots.Db), odd: make() }, (d) => d)
`,
			)!,
			new Map([
				['./index', '/app/index.ts'],
				['./db', '/app/db.ts'],
			]),
		)
		const users = registry.graph().nodes.find((n) => n.id === 'service:Users')
		expect(users!.deps).toEqual([
			{ key: 'db', target: 'slot:Db', optional: false },
			{ key: 'again', target: 'slot:Db', optional: true },
			{ key: 'odd', target: null, optional: false },
		])
	})

	test('reports duplicates in one name space for slots, services and executions', () => {
		const registry = new Registry()
		const a = analyze(
			'/app/a.ts',
			`import { slot } from '@doweljs/core'\nexport const Db = slot('Db')()\n`,
		)!
		const b = analyze(
			'/app/b.ts',
			`import { service } from '@doweljs/core'
export const Db = service('Db', () => 1)
const Again = service('Again', () => 1)
const Twice = service('Again', () => 2)
`,
		)!
		registry.set('/app/a.ts', a, new Map())
		registry.set('/app/b.ts', b, new Map())
		expect(registry.duplicatesOf('/app/b.ts')).toEqual([
			{ id: 'Db', modules: ['/app/a.ts', '/app/b.ts'] },
			{ id: 'Again', modules: ['/app/b.ts', '/app/b.ts'] },
		])
		registry.deleteFile('/app/a.ts')
		expect(registry.graph().duplicates).toEqual([
			{ id: 'Again', modules: ['/app/b.ts', '/app/b.ts'] },
		])
	})

	test('records scope references and does not guess unknown scopes', () => {
		const result = analyze(
			'/app/scopes.ts',
			`import { scope, slot } from '@doweljs/core'
import * as L from './scopes'
export const Session = scope('session')
export const Req = slot('Req', { scope: Session })()
export const Mw = slot('Mw', { scope: L.Request, many: true })()
export const Odd = slot('Odd', { scope: pick() })()
export const Dynamic = slot('Dynamic', options)()
export const Spread = slot('Spread', { ...base })()
export const Computed = slot('Computed', { ['scope']: Session })()
`,
		)!
		const byLocal = new Map(result.declarations.map((d) => [d.local, d]))
		expect(byLocal.get('Session')).toMatchObject({ scope: 'root', scopeRef: null })
		expect(byLocal.get('Req')).toMatchObject({
			scope: null,
			scopeRef: { local: 'Session', member: null },
		})
		expect(byLocal.get('Mw')).toMatchObject({
			scope: null,
			scopeRef: { local: 'L', member: 'Request' },
		})
		expect(byLocal.get('Odd')).toMatchObject({ scope: null, scopeRef: null })
		expect(byLocal.get('Dynamic')).toMatchObject({ scope: null, scopeRef: null, many: null })
		expect(byLocal.get('Spread')).toMatchObject({ scope: null, scopeRef: null, many: null })
		expect(byLocal.get('Computed')).toMatchObject({ scope: null, scopeRef: null })
	})

	test('keeps an execution whose options it cannot read, with what it could not read unknown', () => {
		const result = analyze(
			'/app/run.ts',
			`import { execution } from '@doweljs/core'
export const Run = execution('Run', { ...{}, scope: Job, entry: Entry })
`,
		)!
		expect(result.declarations).toMatchObject([
			{ local: 'Run', kind: 'execution', name: 'Run', scope: null, scopeRef: null, deps: [] },
		])
	})

	test('reads options through TypeScript wrappers', () => {
		const result = analyze(
			'/app/wrapped.ts',
			`import { execution, scope, slot } from '@doweljs/core'
export const Job = scope('job')
export const Mw = slot('Mw', { many: true as const })()
export const Run = execution('Run', { scope: Job, entry: (Runner) } satisfies object)
`,
		)!
		const byLocal = new Map(result.declarations.map((d) => [d.local, d]))
		expect(byLocal.get('Mw')).toMatchObject({ scope: 'root', many: true })
		expect(byLocal.get('Run')).toMatchObject({
			scopeRef: { local: 'Job', member: null },
			deps: [{ key: 'entry', ref: { local: 'Runner', member: null }, optional: false }],
		})
	})
})
