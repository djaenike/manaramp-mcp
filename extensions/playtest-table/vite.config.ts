import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { addWorkerExports } from '@oselvar/sveltekit-add-worker-exports';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) => filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		}),
		// Merges the GameRoom Durable Object class in as a named export alongside SvelteKit's own
		// default fetch handler in the built worker — otherwise adapter-cloudflare's generated
		// worker only exports `fetch` and wrangler has no way to find the DO class by name.
		addWorkerExports({ entryPoint: 'src/lib/server/worker-exports.ts' })
	]
});
