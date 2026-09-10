#!/usr/bin/env node
// Builds `dist/` into a directory Chrome can load unpacked: three bundled
// entry points plus the static files that reference them.
//
// Why esbuild, and why a script rather than a CLI line:
//
// - The extension now imports `@xarsh/archivebridge`, so `tsc` alone is no
//   longer enough: the library and its dependency graph have to be bundled
//   into each extension context (a service worker, an offscreen document
//   and a popup, none of which can resolve bare npm specifiers).
// - esbuild does exactly that and nothing else. A WebExtension framework
//   (WXT and friends) would additionally own the manifest, the dev server,
//   per-browser output and an HTML pipeline — none of which this extension
//   needs: it has one hand-written manifest, three entry points and two
//   static HTML files. See docs/architecture.md, "Building the extension".
// - Using esbuild's JS API keeps the build one readable file, and has the
//   side benefit of not needing the `esbuild` package's postinstall step
//   (the API resolves the platform binary itself), so `npm ci` needs no
//   install-script allowance for it.
//
// Kept as plain `.mjs` for the same reason `scripts/` is: this is
// dependency-free build tooling that must run under a bare `node` with no
// tsconfig and no build step of its own. See CONTRIBUTING.md, "TypeScript
// conventions".

import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = dirname(fileURLToPath(import.meta.url))
const outDir = join(root, 'dist')

const STATIC_FILES = ['manifest.json', 'popup.html', 'offscreen.html']

/** The three extension contexts. Each is its own bundle: they load independently and share no module instance at runtime. */
const ENTRY_POINTS = {
	background: 'src/chrome/background.ts',
	offscreen: 'src/chrome/offscreen.ts',
	popup: 'src/popup/popup.ts',
}

/** Set `ARCHIVEBRIDGE_EXTENSION_MINIFY=0` to build readable output — useful when debugging a bundled service worker in Chrome DevTools. */
const minify = process.env.ARCHIVEBRIDGE_EXTENSION_MINIFY !== '0'

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

const result = await build({
	entryPoints: Object.fromEntries(Object.entries(ENTRY_POINTS).map(([name, entry]) => [name, join(root, entry)])),
	outdir: outDir,
	bundle: true,
	// The extension targets Chromium 116+ (`minimum_chrome_version` in the
	// manifest); `format: esm` matches the manifest's `"type": "module"`
	// service worker and the `<script type="module">` tags in the HTML.
	format: 'esm',
	platform: 'browser',
	target: 'chrome116',
	splitting: false,
	minify,
	sourcemap: 'linked',
	logLevel: 'warning',
	metafile: true,
})

// Nothing above configures a `Buffer` shim, and that is deliberate:
// `@xarsh/archivebridge` pulls in `iconv-lite` for legacy-charset
// encode/decode, which is written against Node's `Buffer` and
// `string_decoder`, and both are resolved from real polyfill packages
// declared as dependencies of this app — like any other dependency, with no
// aliasing here. Stubbing `iconv-lite` out instead would silently change
// what the library does with a non-UTF-8 resource. See
// docs/architecture.md, "Building the extension".

await Promise.all(STATIC_FILES.map((file) => cp(join(root, file), join(outDir, file))))

const sizes = Object.entries(result.metafile.outputs)
	.filter(([file]) => file.endsWith('.js'))
	.map(([file, output]) => `${file.slice(file.lastIndexOf('/') + 1)} ${(output.bytes / 1024).toFixed(1)} kB`)
console.log(`extension built into dist/ (${minify ? 'minified' : 'unminified'}): ${sizes.join(', ')}`)
