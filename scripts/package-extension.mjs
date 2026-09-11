#!/usr/bin/env node
// Packages the built Chrome/Edge extension into a loadable-unpacked ZIP for
// GitHub Releases: artifacts/archivebridge-chrome-<version>.zip. Run via
// `npm run package:extension` (which checks version consistency first — see
// scripts/check-versions.mjs).
//
// Uses `adm-zip` (a repo dev/release-tooling dependency only, never a
// dependency of a published workspace) because it both writes and reads
// ZIPs, so the same library that builds the artifact also verifies it
// below — no second package needed just for inspection. See
// CONTRIBUTING.md, "Dependency policy".

import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const distDir = join(root, 'apps/extension/dist')
const artifactsDir = join(root, 'artifacts')

/** Entries the packaged ZIP must contain at its root. */
const REQUIRED_ENTRIES = ['manifest.json', 'background.js', 'offscreen.js', 'popup.js', 'viewer.js', 'popup.html', 'offscreen.html', 'viewer.html']

/** Path prefixes that must never appear in the packaged ZIP. */
const FORBIDDEN_PREFIXES = ['dist/', 'src/', 'e2e/', 'node_modules/']

function readCanonicalVersion() {
	const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
	return version
}

function buildExtension() {
	// Builds every workspace (library, then extension, per the root
	// `workspaces` order) — the extension's build resolves
	// `@xarsh/archivebridge` from the library's own `dist/`, so it has to
	// exist first. Same reasoning as `npm run check`; see CONTRIBUTING.md,
	// "npm scripts".
	const result = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
	if (result.status !== 0) {
		console.error('package:extension: build failed')
		process.exit(result.status ?? 1)
	}
}

/** Every file under `dir`, as POSIX-style paths relative to `dir`, sorted for deterministic ZIP entry order. */
function listFilesSorted(dir) {
	const files = []
	const walk = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const entryPath = join(current, entry.name)
			if (entry.isDirectory()) {
				walk(entryPath)
			} else {
				files.push(relative(dir, entryPath).split(sep).join('/'))
			}
		}
	}
	walk(dir)
	return files.sort()
}

/** Fixed entry timestamp so re-packaging identical input bytes reproduces an identical ZIP. */
const DETERMINISTIC_ENTRY_TIME = new Date('1980-01-01T00:00:00Z')

function createZip(files) {
	const zip = new AdmZip()
	for (const file of files) {
		const content = readFileSync(join(distDir, file))
		const entry = zip.addFile(file, content)
		entry.header.time = DETERMINISTIC_ENTRY_TIME
	}
	return zip
}

function validateZip(artifactPath, version) {
	const zip = new AdmZip(artifactPath)
	const entries = zip.getEntries()

	if (entries.length === 0) {
		throw new Error('packaged ZIP is empty')
	}

	for (const name of REQUIRED_ENTRIES) {
		if (zip.getEntry(name) === null) {
			throw new Error(`packaged ZIP is missing required entry: ${name}`)
		}
	}

	for (const entry of entries) {
		if (FORBIDDEN_PREFIXES.some((prefix) => entry.entryName.startsWith(prefix))) {
			throw new Error(`packaged ZIP contains a forbidden entry: ${entry.entryName}`)
		}
	}

	const manifest = JSON.parse(zip.readAsText('manifest.json'))
	if (manifest.version !== version) {
		throw new Error(`packaged manifest.json version is "${manifest.version}", expected "${version}"`)
	}
}

function formatSize(bytes) {
	return `${(bytes / 1024).toFixed(1)} kB`
}

function main() {
	const version = readCanonicalVersion()

	buildExtension()

	const files = listFilesSorted(distDir)
	const zip = createZip(files)

	mkdirSync(artifactsDir, { recursive: true })
	const artifactPath = join(artifactsDir, `archivebridge-chrome-${version}.zip`)
	rmSync(artifactPath, { force: true })
	zip.writeZip(artifactPath)

	validateZip(artifactPath, version)

	const { size } = statSync(artifactPath)
	console.log(`package:extension: wrote ${relative(root, artifactPath)} (${formatSize(size)})`)
}

main()
