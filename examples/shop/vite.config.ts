import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
// Inside the monorepo the packages are used from source. A real project
// imports `@doweljs/vite` and `@doweljs/devtools` and lets Vite resolve
// `@doweljs/core` normally.
import devtools from '../../packages/devtools/src/index.ts'
import dowel from '../../packages/vite/src/index.ts'

const source = (path: string) =>
	fileURLToPath(new URL(`../../packages/dowel/src/${path}`, import.meta.url))

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@doweljs\/core\/evolve$/, replacement: source('evolve.ts') },
			{ find: /^@doweljs\/core$/, replacement: source('index.ts') },
		],
	},
	plugins: [dowel(), devtools()],
	server: { fs: { allow: ['../..'] } },
})
