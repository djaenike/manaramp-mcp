// wrangler.jsonc has no entry for these — they're Worker secrets/vars set via `wrangler secret
// put` or the Cloudflare dashboard, never declared as bindings, so `wrangler types` never picks
// them up into the generated (gitignored) worker-configuration.d.ts. This file augments that
// generated `interface Env` via TypeScript's declaration merging instead, and survives every
// `wrangler types` regeneration since nothing else touches it.
declare global {
	interface Env {
		ANTHROPIC_API_KEY: string;
		ANTHROPIC_MODEL?: string;
	}
}

export {};
