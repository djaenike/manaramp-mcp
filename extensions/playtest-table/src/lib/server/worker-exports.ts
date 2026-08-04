// Entry point for the sveltekit-add-worker-exports Vite plugin (see vite.config.ts) — anything
// exported here gets merged as a named export alongside SvelteKit's own default fetch handler in
// the final Cloudflare Worker bundle, which is how wrangler.jsonc's durable_objects binding is
// able to find the GameRoom class by name at runtime.
export { GameRoom } from './game-room';
