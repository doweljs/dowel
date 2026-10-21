/**
 * Checks dowel as users get it: packs the package, unpacks it into a
 * temporary project's node_modules, and there
 *
 * - compiles `package-fixture/app.ts` with declarations on, under
 *   TypeScript 5.9 and 7 and several compiler settings, so every inferred
 *   type a user's declaration file names must be exported by the entry;
 * - runs `package-fixture/smoke.mjs` under Node.
 *
 * Inside the workspace `@doweljs/core` resolves through a symlink, so a type the
 * entry does not export is still reachable by a relative path, and only a
 * real install shows the error.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const fixture = join(import.meta.dir, 'package-fixture')
const work = mkdtempSync(join(tmpdir(), 'dowel-package-'))

/** Runs a command and returns its output, or fails with it. */
function run(command: string[], cwd: string): string {
	const result = Bun.spawnSync(command, { cwd })
	const output = `${result.stdout.toString()}${result.stderr.toString()}`
	if (result.exitCode !== 0) throw new Error(`${command.join(' ')} failed:\n${output}`)
	return output
}

const compilers = {
	'TypeScript 5.9': join(root, 'node_modules/typescript59/bin/tsc'),
	'TypeScript 7': join(root, 'node_modules/typescript/bin/tsc'),
}

/** Compiler settings users plausibly have; every one must accept the fixture. */
const settings = [
	{ module: 'esnext', moduleResolution: 'bundler', strict: true, exactOptionalPropertyTypes: true },
	{ module: 'nodenext', moduleResolution: 'nodenext', strict: true },
	{ module: 'esnext', moduleResolution: 'bundler', strict: false },
]

try {
	const dowel = join(root, 'packages/dowel')
	run(['bun', 'run', 'build'], dowel)
	const tarball = run(['npm', 'pack', '--silent', '--pack-destination', work], dowel).trim()
	const project = join(work, 'project')
	const installed = join(project, 'node_modules/@doweljs/core')
	mkdirSync(installed, { recursive: true })
	run(['tar', '-xzf', join(work, tarball), '-C', installed, '--strip-components=1'], work)
	writeFileSync(join(project, 'package.json'), '{ "type": "module" }\n')
	cpSync(fixture, project, { recursive: true })

	const failures: string[] = []
	for (const [compiler, tsc] of Object.entries(compilers)) {
		for (const options of settings) {
			const tsconfig = {
				compilerOptions: {
					target: 'ES2022',
					lib: ['ES2022', 'ESNext.Disposable', 'DOM'],
					declaration: true,
					emitDeclarationOnly: true,
					outDir: 'out',
					skipLibCheck: false,
					types: [],
					...options,
				},
				files: ['app.ts'],
			}
			writeFileSync(join(project, 'tsconfig.json'), JSON.stringify(tsconfig))
			const result = Bun.spawnSync(['node', tsc, '-p', project], { cwd: project })
			if (result.exitCode !== 0) {
				failures.push(`${compiler}, ${JSON.stringify(options)}:\n${result.stdout.toString()}`)
			}
		}
	}
	run(['node', 'smoke.mjs'], project)
	const node = run(['node', '--version'], project).trim()

	if (failures.length > 0) {
		console.error(failures.join('\n'))
		process.exit(1)
	}
	console.log(
		`The packed package compiles under ${Object.keys(compilers).length * settings.length} configurations and runs under Node ${node}.`,
	)
} finally {
	rmSync(work, { recursive: true, force: true })
}
