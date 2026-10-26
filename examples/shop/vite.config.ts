import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Inside the monorepo the library is used from source. A real project lets Vite resolve `@doweljs/core` normally.
const source = fileURLToPath(new URL('../../packages/dowel/src/index.ts', import.meta.url))

export default defineConfig({
	resolve: { alias: [{ find: /^@doweljs\/core$/, replacement: source }] },
	server: { fs: { allow: ['../..'] } },
})
