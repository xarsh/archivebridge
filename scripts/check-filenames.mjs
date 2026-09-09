#!/usr/bin/env node
// Enforces lowercase kebab-case naming for project-owned files/directories
// and flags names that are hazardous on some platform (Windows reserved
// device names, trailing dots/spaces, characters Windows can't store).
// Complements biome.json's `useFilenamingConvention` (JS/TS only) by
// covering every git-tracked-or-addable path, regardless of file type.

import { execFileSync } from 'node:child_process'

/** Exact basenames exempt from the kebab-case requirement: ecosystem/tool-mandated names. */
const EXEMPT_BASENAMES = new Set([
	'README.md',
	'CONTRIBUTING.md',
	'LICENSE',
	'package.json',
	'package-lock.json',
	'tsconfig.json',
	'tsconfig.build.json',
	'biome.json',
	'mise.toml',
	'.gitignore',
	'.gitattributes',
	'manifest.json', // required exact name for Chrome/WebExtension manifests
])

/** Directory path segments exempt from the kebab-case requirement: ecosystem/tool-mandated dirs. */
const EXEMPT_DIR_SEGMENTS = new Set(['.github'])

const KEBAB_SEGMENT = /^[a-z0-9]+(-[a-z0-9]+)*$/

// Windows reserved device basenames (case-insensitive, extension-independent).
const WINDOWS_RESERVED_NAMES = new Set([
	'con',
	'prn',
	'aux',
	'nul',
	'com1',
	'com2',
	'com3',
	'com4',
	'com5',
	'com6',
	'com7',
	'com8',
	'com9',
	'lpt1',
	'lpt2',
	'lpt3',
	'lpt4',
	'lpt5',
	'lpt6',
	'lpt7',
	'lpt8',
	'lpt9',
])

// Characters that can't appear in a Windows path segment.
const WINDOWS_ILLEGAL_CHARS = /[<>:"|?*\\]/

function hasControlCharacter(segment) {
	for (let i = 0; i < segment.length; i++) {
		if (segment.charCodeAt(i) < 0x20) return true
	}
	return false
}

function listProjectPaths() {
	const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
		encoding: 'utf8',
	})
	return output.split('\0').filter((path) => path.length > 0)
}

function checkSegment(segment, { isDir }) {
	const problems = []

	if (segment.endsWith('.') || segment.endsWith(' ') || segment.startsWith(' ')) {
		problems.push('has a leading/trailing space or trailing dot (unsafe on Windows)')
	}
	if (WINDOWS_ILLEGAL_CHARS.test(segment) || hasControlCharacter(segment)) {
		problems.push('contains a character that is illegal in a Windows path')
	}

	const stem = segment.split('.')[0]
	if (WINDOWS_RESERVED_NAMES.has(stem.toLowerCase())) {
		problems.push(`"${stem}" is a reserved device name on Windows`)
	}

	const exempt = isDir ? EXEMPT_DIR_SEGMENTS.has(segment) : EXEMPT_BASENAMES.has(segment)
	if (!exempt) {
		const parts = segment.split('.')
		const nonKebabPart = parts.find((part) => !KEBAB_SEGMENT.test(part))
		if (nonKebabPart !== undefined) {
			problems.push('is not lowercase kebab-case')
		}
	}

	return problems
}

function checkPath(path) {
	const segments = path.split('/')
	const violations = []
	segments.forEach((segment, index) => {
		const isDir = index < segments.length - 1
		for (const problem of checkSegment(segment, { isDir })) {
			violations.push(`${path}: "${segment}" ${problem}`)
		}
	})
	return violations
}

function main() {
	const paths = listProjectPaths()
	const violations = paths.flatMap(checkPath)

	if (violations.length === 0) {
		console.log(`check-filenames: ${paths.length} paths OK`)
		return
	}

	console.error('check-filenames: naming policy violations found:\n')
	for (const violation of violations) {
		console.error(`  ${violation}`)
	}
	console.error(`\n${violations.length} violation(s) in ${paths.length} paths.`)
	process.exitCode = 1
}

main()
