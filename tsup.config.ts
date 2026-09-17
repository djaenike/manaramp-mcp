import { defineConfig } from "tsup";

// bundle: false -- this is a straight per-file transpile (mirrors tsc's rootDir/outDir behavior),
// NOT a bundler pass. That's deliberate: sub-tools/delivery/html_renderer.ts locates
// deck_report_template.html relative to ITS OWN compiled file location via import.meta.url (see
// its header comment) -- bundling it into tools/index.js and local/index.js separately would
// duplicate that code into two different output locations and break the relative lookup. Keeping
// dist/'s folder structure identical to src/'s (sub-tools/, tools/, local/) preserves every
// existing import.meta.url-relative path assumption (html_renderer.ts's template lookup; local/
// index.ts's card_cache/ + card_ratings/ + arena_settings.json, which walk back up to the package
// root) exactly as they behaved when this was plain, unbuilt JS.
export default defineConfig({
  entry: ["src/**/*.ts"],
  format: ["esm"],
  outDir: "dist",
  bundle: false,
  splitting: false,
  sourcemap: false,
  clean: true,
  target: "es2022",
  // Without this, consuming manaramp-mcp as a real installed package (as opposed to a `file:`
  // symlink straight at this repo) leaves every import from it implicitly `any` -- there were never
  // .d.ts files next to dist/'s .js output, only a package.json `exports` map pointing at plain JS.
  dts: true,
});
