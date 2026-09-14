#!/usr/bin/env node
// Enforces locked-step versioning: root, the library package, the extension
// package, and every per-browser extension manifest must all report the
// same version.
// ArchiveBridge is deliberately one product with one version, not
// independently versioned components — see CONTRIBUTING.md, "Locked-step
// versioning".

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const SOURCES = [
	{ file: 'package.json', path: join(root, 'package.json') },
	{ file: 'packages/archivebridge/package.json', path: join(root, 'packages/archivebridge/package.json') },
	{ file: 'apps/extension/package.json', path: join(root, 'apps/extension/package.json') },
	{ file: 'apps/extension/manifest.json', path: join(root, 'apps/extension/manifest.json') },
	{ file: 'apps/extension/manifest.firefox.json', path: join(root, 'apps/extension/manifest.firefox.json') },
]

function readVersion({ file, path }) {
	const contents = JSON.parse(readFileSync(path, 'utf8'))
	return { file, version: contents.version }
}

function main() {
	const versions = SOURCES.map(readVersion)
	const canonical = versions[0].version
	const mismatched = versions.filter((entry) => entry.version !== canonical)

	if (mismatched.length > 0) {
		console.error('check:versions: version mismatch found:\n')
		for (const { file, version } of versions) {
			console.error(`  ${file}: ${version}`)
		}
		process.exitCode = 1
		return
	}

	console.log(`check:versions: ${versions.length} files at ${canonical}`)
}

main()
