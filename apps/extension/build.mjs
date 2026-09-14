#!/usr/bin/env node
// Builds one directory per browser target that the browser can load
// unpacked: the bundled entry points plus the static files that reference
// them.
//
// `dist/` is Chrome/Edge and is the complete product. `dist-firefox/` is
// Firefox and is deliberately smaller: it carries the command path and the
// popup, with the capture and save adapters behind them still unwritten
// (see `src/firefox/`). A per-browser manifest and output directory is a
// normal shape for a cross-browser extension — see docs/architecture.md,
// "Per-browser manifests" — and it stays a manifest choice plus an
// entry-point list here, never a framework.
//
// Why esbuild, and why a script rather than a CLI line:
//
// - The extension now imports `@xarsh/archivebridge`, so `tsc` alone is no
//   longer enough: the library and its dependency graph have to be bundled
//   into each extension context (a service worker, an offscreen document,
//   a popup and the archive viewer, none of which can resolve bare npm
//   specifiers).
// - esbuild does exactly that and nothing else. A WebExtension framework
//   (WXT and friends) would additionally own the manifest, the dev server,
//   per-browser output and an HTML pipeline — none of which this extension
//   needs: it has one hand-written manifest, four entry points and three
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

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = dirname(fileURLToPath(import.meta.url))

/**
 * One entry per browser target.
 *
 * `manifest` is copied in as `manifest.json` — the name every browser
 * requires — so the per-browser source files can sit side by side.
 * `entryPoints` are the extension contexts: each is its own bundle,
 * because they load independently and share no module instance at
 * runtime. `staticFiles` are the files that reference them.
 */
const TARGETS = [
	{
		name: 'chrome',
		outDir: 'dist',
		manifest: 'manifest.json',
		staticFiles: ['popup.html', 'offscreen.html', 'viewer.html', 'icons'],
		entryPoints: {
			background: 'src/chrome/background.ts',
			offscreen: 'src/chrome/offscreen.ts',
			popup: 'src/popup/popup.ts',
			viewer: 'src/viewer/viewer.ts',
		},
	},
	{
		name: 'firefox',
		outDir: 'dist-firefox',
		manifest: 'manifest.firefox.json',
		// `popup.html` is shared verbatim with Chrome: the markup and element
		// IDs are identical and each target bundles its own `popup.js` beside
		// it. The scripts differ (see `src/firefox/popup.ts`); the markup does
		// not, and duplicating it would only let the two drift.
		staticFiles: ['popup.html', 'icons'],
		entryPoints: {
			background: 'src/firefox/background.ts',
			popup: 'src/firefox/popup.ts',
		},
	},
]

/** Set `ARCHIVEBRIDGE_EXTENSION_MINIFY=0` to build readable output — useful when debugging a bundled service worker in Chrome DevTools. */
const minify = process.env.ARCHIVEBRIDGE_EXTENSION_MINIFY !== '0'

for (const target of TARGETS) {
	const outDir = join(root, target.outDir)
	await rm(outDir, { recursive: true, force: true })
	await mkdir(outDir, { recursive: true })

	const result = await build({
		entryPoints: Object.fromEntries(Object.entries(target.entryPoints).map(([name, entry]) => [name, join(root, entry)])),
		outdir: outDir,
		bundle: true,
		// `format: esm` matches both manifests: Chrome's `"type": "module"`
		// service worker, Firefox's `"type": "module"` background scripts, and
		// the `<script type="module">` tags in the shared HTML. The `target` is
		// the older of the two engine floors (`minimum_chrome_version: 116` and
		// `strict_min_version: 128.0`, which is Firefox 128 / roughly the same
		// language level), so one setting covers both outputs.
		format: 'esm',
		platform: 'browser',
		target: ['chrome116', 'firefox128'],
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

	// `icons/` also holds `icon-master-512.png` (the source the four shipped
	// sizes are generated from) and, on macOS, stray Finder metadata — neither
	// belongs in a loadable extension or the ZIP `package:extension` builds from
	// this same `dist/`. Each manifest's own `icons` map is the one place its
	// shipped set is declared, so it is what filters the copy, rather than a
	// second, driftable list here.
	const manifestJson = await readFile(join(root, target.manifest), 'utf8')
	const shippedIconFiles = new Set(Object.values(JSON.parse(manifestJson).icons).map((iconPath) => basename(iconPath)))

	// The manifest is copied under the name every browser requires, so the two
	// per-browser sources can live side by side in the source tree.
	await writeFile(join(outDir, 'manifest.json'), manifestJson)

	await Promise.all(
		target.staticFiles.map((file) =>
			cp(join(root, file), join(outDir, file), {
				recursive: true,
				filter: (src) => {
					const name = basename(src)
					return name === file || shippedIconFiles.has(name)
				},
			}),
		),
	)

	const sizes = Object.entries(result.metafile.outputs)
		.filter(([file]) => file.endsWith('.js'))
		.map(([file, output]) => `${file.slice(file.lastIndexOf('/') + 1)} ${(output.bytes / 1024).toFixed(1)} kB`)
	console.log(`${target.name} extension built into ${target.outDir}/ (${minify ? 'minified' : 'unminified'}): ${sizes.join(', ')}`)
}
