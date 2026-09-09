import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBinary } from 'plist'
import { convertMhtmlToWebArchive } from '../convert/to-web-archive.ts'
import type { Diagnostic } from '../model/archive.ts'
import type { MhtmlDocument, MhtmlPart } from '../model/mhtml.ts'
import { buildSidecarPart, findSidecarPart, findSidecarPartIndices, parseSidecarPart, SIDECAR_MEDIA_TYPE, type SidecarData } from './sidecar.ts'

function htmlPart(overrides: Partial<MhtmlPart> = {}): MhtmlPart {
	return {
		contentId: 'root@archivebridge',
		location: 'https://example.invalid/',
		mimeType: 'text/html',
		textEncoding: 'utf-8',
		data: new TextEncoder().encode('<html></html>'),
		...overrides,
	}
}

test('findSidecarPart returns undefined when no part matches the sidecar media type', () => {
	const document: MhtmlDocument = { parts: [htmlPart()], rootPartIndex: 0 }
	const diagnostics: Diagnostic[] = []
	assert.equal(findSidecarPart(document, diagnostics), undefined)
	assert.deepEqual(diagnostics, [])
})

test('findSidecarPart locates the single sidecar part by parsed (already-lowercased) mimeType', () => {
	const sidecar = buildSidecarPart(new Map())
	const document: MhtmlDocument = { parts: [htmlPart(), sidecar], rootPartIndex: 0 }
	const diagnostics: Diagnostic[] = []

	const found = findSidecarPart(document, diagnostics)
	assert.deepEqual(diagnostics, [])
	assert.equal(found?.index, 1)
	assert.equal(found?.part.mimeType, SIDECAR_MEDIA_TYPE)
})

test('findSidecarPart reports duplicate-metadata-sidecar for two or more matches, without picking one', () => {
	const document: MhtmlDocument = { parts: [htmlPart(), buildSidecarPart(new Map()), buildSidecarPart(new Map())], rootPartIndex: 0 }
	const diagnostics: Diagnostic[] = []

	const found = findSidecarPart(document, diagnostics)
	assert.equal(found, undefined)
	assert.deepEqual(diagnostics, [{ type: 'duplicate-metadata-sidecar', count: 2 }])
})

test('buildSidecarPart / parseSidecarPart round-trip webResourceResponse, webResourceFrameName, resourceExtra, and documentExtra', () => {
	const entries: SidecarData = new Map([
		[
			'child@archivebridge',
			{
				webResourceResponse: new Uint8Array([1, 2, 3]),
				webResourceFrameName: '<!--frame1-->',
				resourceExtra: new Map([['SomeResourceKey', 'value']]),
				documentExtra: new Map([['SomeDocumentKey', 42]]),
			},
		],
		[
			'plain@archivebridge',
			{
				webResourceResponse: undefined,
				webResourceFrameName: undefined,
				resourceExtra: undefined,
				documentExtra: undefined,
			},
		],
	])

	const part = buildSidecarPart(entries)
	assert.equal(part.mimeType, SIDECAR_MEDIA_TYPE)
	assert.equal(part.contentId, undefined)
	assert.equal(part.location, undefined)

	const diagnostics: Diagnostic[] = []
	const parsed = parseSidecarPart(part, diagnostics)
	assert.deepEqual(diagnostics, [])
	assert.deepEqual(parsed?.get('child@archivebridge'), entries.get('child@archivebridge'))
	// Empty/absent optional fields are not written at all, so they read back as undefined, not empty maps.
	assert.deepEqual(parsed?.get('plain@archivebridge'), { webResourceResponse: undefined, webResourceFrameName: undefined, resourceExtra: undefined, documentExtra: undefined })
})

test('parseSidecarPart reports malformed-metadata-sidecar for a part whose body is not a valid plist', () => {
	const part: MhtmlPart = { contentId: undefined, location: undefined, mimeType: SIDECAR_MEDIA_TYPE, textEncoding: undefined, data: new TextEncoder().encode('not a plist') }
	const diagnostics: Diagnostic[] = []

	const parsed = parseSidecarPart(part, diagnostics)
	assert.equal(parsed, undefined)
	assert.equal(diagnostics.length, 1)
	assert.equal(diagnostics[0]?.type, 'malformed-metadata-sidecar')
})

test('parseSidecarPart reports malformed-metadata-sidecar for a well-formed plist missing a resources dictionary', () => {
	const part = buildSidecarPart(new Map())
	// Overwrite with a plist that has no "resources" key at all.
	const malformed: MhtmlPart = { ...part, data: new TextEncoder().encode('not-a-plist-either') }
	const diagnostics: Diagnostic[] = []

	const parsed = parseSidecarPart(malformed, diagnostics)
	assert.equal(parsed, undefined)
	assert.equal(diagnostics[0]?.type, 'malformed-metadata-sidecar')
})

test('findSidecarPart / findSidecarPartIndices locate the sidecar part by media type case-insensitively', () => {
	const sidecar = buildSidecarPart(new Map())
	const document: MhtmlDocument = { parts: [htmlPart(), { ...sidecar, mimeType: 'Application/Vnd.ArchiveBridge.Metadata' }], rootPartIndex: 0 }
	const diagnostics: Diagnostic[] = []

	const found = findSidecarPart(document, diagnostics)
	assert.deepEqual(diagnostics, [])
	assert.equal(found?.index, 1)
	assert.deepEqual(findSidecarPartIndices(document), [1])
})

test('findSidecarPartIndices returns every sidecar-media-type part index even when there are two or more (unlike findSidecarPart, which returns undefined for that case)', () => {
	const document: MhtmlDocument = { parts: [htmlPart(), buildSidecarPart(new Map()), buildSidecarPart(new Map())], rootPartIndex: 0 }
	const diagnostics: Diagnostic[] = []

	assert.equal(findSidecarPart(document, diagnostics), undefined)
	assert.deepEqual(findSidecarPartIndices(document), [1, 2])
})

test('findSidecarPartIndices includes a malformed sidecar-media-type part too (its validity is irrelevant to exclusion from ordinary resource grouping)', () => {
	const malformed: MhtmlPart = { contentId: undefined, location: undefined, mimeType: SIDECAR_MEDIA_TYPE, textEncoding: undefined, data: new TextEncoder().encode('not a plist') }
	const document: MhtmlDocument = { parts: [htmlPart(), malformed], rootPartIndex: 0 }
	assert.deepEqual(findSidecarPartIndices(document), [1])
})

test('parseSidecarPart accepts ArchiveBridgeSchemaVersion 1 (the current supported version)', () => {
	const part = buildSidecarPart(
		new Map([['child@archivebridge', { webResourceResponse: undefined, webResourceFrameName: 'ok', resourceExtra: undefined, documentExtra: undefined }]]),
	)
	const diagnostics: Diagnostic[] = []
	const parsed = parseSidecarPart(part, diagnostics)
	assert.deepEqual(diagnostics, [])
	assert.equal(parsed?.get('child@archivebridge')?.webResourceFrameName, 'ok')
})

test('parseSidecarPart reports malformed-metadata-sidecar and ignores the sidecar when ArchiveBridgeSchemaVersion is missing', () => {
	const data = buildBinary({ resources: { 'child@archivebridge': { webResourceFrameName: 'ok' } } })
	const part: MhtmlPart = { contentId: undefined, location: undefined, mimeType: SIDECAR_MEDIA_TYPE, textEncoding: undefined, data }
	const diagnostics: Diagnostic[] = []

	const parsed = parseSidecarPart(part, diagnostics)
	assert.equal(parsed, undefined)
	assert.equal(diagnostics.length, 1)
	assert.equal(diagnostics[0]?.type, 'malformed-metadata-sidecar')
})

test('parseSidecarPart reports malformed-metadata-sidecar and ignores the sidecar for an unknown future ArchiveBridgeSchemaVersion, rather than misreading it as version 1', () => {
	const data = buildBinary({ ArchiveBridgeSchemaVersion: 2, resources: { 'child@archivebridge': { webResourceFrameName: 'should-not-be-read' } } })
	const part: MhtmlPart = { contentId: undefined, location: undefined, mimeType: SIDECAR_MEDIA_TYPE, textEncoding: undefined, data }
	const diagnostics: Diagnostic[] = []

	const parsed = parseSidecarPart(part, diagnostics)
	assert.equal(parsed, undefined)
	assert.equal(diagnostics.length, 1)
	assert.equal(diagnostics[0]?.type, 'malformed-metadata-sidecar')
})

test('parseSidecarPart rejects the whole sidecar (not just the bad entry) when a resources entry is not a dictionary', () => {
	const data = buildBinary({ ArchiveBridgeSchemaVersion: 1, resources: { 'good@archivebridge': { webResourceFrameName: 'fine' }, 'bad@archivebridge': 'not-a-dictionary' } })
	const part: MhtmlPart = { contentId: undefined, location: undefined, mimeType: SIDECAR_MEDIA_TYPE, textEncoding: undefined, data }
	const diagnostics: Diagnostic[] = []

	const parsed = parseSidecarPart(part, diagnostics)
	assert.equal(parsed, undefined)
	assert.equal(diagnostics.length, 1)
	assert.equal(diagnostics[0]?.type, 'malformed-metadata-sidecar')
})

test('parseSidecarPart rejects the whole sidecar when webResourceResponse has the wrong type, rather than silently reading it as undefined', () => {
	const data = buildBinary({ ArchiveBridgeSchemaVersion: 1, resources: { 'child@archivebridge': { webResourceResponse: 'not-data-bytes' } } })
	const part: MhtmlPart = { contentId: undefined, location: undefined, mimeType: SIDECAR_MEDIA_TYPE, textEncoding: undefined, data }
	const diagnostics: Diagnostic[] = []

	const parsed = parseSidecarPart(part, diagnostics)
	assert.equal(parsed, undefined)
	assert.equal(diagnostics.length, 1)
	assert.equal(diagnostics[0]?.type, 'malformed-metadata-sidecar')
})

test('parseSidecarPart rejects the whole sidecar when webResourceFrameName has the wrong type, rather than silently reading it as undefined', () => {
	const data = buildBinary({ ArchiveBridgeSchemaVersion: 1, resources: { 'child@archivebridge': { webResourceFrameName: 42 } } })
	const part: MhtmlPart = { contentId: undefined, location: undefined, mimeType: SIDECAR_MEDIA_TYPE, textEncoding: undefined, data }
	const diagnostics: Diagnostic[] = []

	const parsed = parseSidecarPart(part, diagnostics)
	assert.equal(parsed, undefined)
	assert.equal(diagnostics.length, 1)
	assert.equal(diagnostics[0]?.type, 'malformed-metadata-sidecar')
})

test('parseSidecarPart rejects the whole sidecar when resourceExtra/documentExtra have the wrong type, rather than silently reading them as undefined', () => {
	for (const key of ['resourceExtra', 'documentExtra']) {
		const data = buildBinary({ ArchiveBridgeSchemaVersion: 1, resources: { 'child@archivebridge': { [key]: 'not-a-dictionary' } } })
		const part: MhtmlPart = { contentId: undefined, location: undefined, mimeType: SIDECAR_MEDIA_TYPE, textEncoding: undefined, data }
		const diagnostics: Diagnostic[] = []

		const parsed = parseSidecarPart(part, diagnostics)
		assert.equal(parsed, undefined, `key ${key}`)
		assert.equal(diagnostics.length, 1, `key ${key}`)
		assert.equal(diagnostics[0]?.type, 'malformed-metadata-sidecar', `key ${key}`)
	}
})

test('parseSidecarPart rejects the whole sidecar when resourceExtra claims a reserved WebArchive resource key', () => {
	// The sidecar is the route by which a *foreign* archive's residual metadata
	// becomes a WebArchiveDocument's `extra`, so a reserved key here would flow
	// through MHTML -> WebArchive and hit serializeWebArchive's rejection later.
	// Catching it at the sidecar boundary keeps the surrounding MHTML conversion
	// working (metadata simply absent) instead of producing an unserializable model.
	for (const key of ['WebResourceURL', 'WebResourceMIMEType', 'WebResourceData', 'WebResourceTextEncodingName', 'WebResourceResponse', 'WebResourceFrameName']) {
		const data = buildBinary({ ArchiveBridgeSchemaVersion: 1, resources: { 'child@archivebridge': { resourceExtra: { [key]: 'hijacked' } } } })
		const part: MhtmlPart = { contentId: undefined, location: undefined, mimeType: SIDECAR_MEDIA_TYPE, textEncoding: undefined, data }
		const diagnostics: Diagnostic[] = []

		assert.equal(parseSidecarPart(part, diagnostics), undefined, `key ${key}`)
		assert.equal(diagnostics.length, 1, `key ${key}`)
		assert.equal(diagnostics[0]?.type, 'malformed-metadata-sidecar', `key ${key}`)
	}
})

test('parseSidecarPart rejects the whole sidecar when documentExtra claims a reserved WebArchive document key', () => {
	for (const key of ['WebMainResource', 'WebSubresources', 'WebSubframeArchives']) {
		const data = buildBinary({ ArchiveBridgeSchemaVersion: 1, resources: { 'child@archivebridge': { documentExtra: { [key]: 'hijacked' } } } })
		const part: MhtmlPart = { contentId: undefined, location: undefined, mimeType: SIDECAR_MEDIA_TYPE, textEncoding: undefined, data }
		const diagnostics: Diagnostic[] = []

		assert.equal(parseSidecarPart(part, diagnostics), undefined, `key ${key}`)
		assert.equal(diagnostics.length, 1, `key ${key}`)
		assert.equal(diagnostics[0]?.type, 'malformed-metadata-sidecar', `key ${key}`)
	}
})

test('parseSidecarPart still accepts a sidecar whose resourceExtra/documentExtra carry only ordinary unknown keys', () => {
	const data = buildBinary({
		ArchiveBridgeSchemaVersion: 1,
		resources: {
			'child@archivebridge': {
				resourceExtra: { SomeFutureAppleResourceKey: 'resource-level-value' },
				documentExtra: { SomeFutureAppleDocumentKey: 'document-level-value' },
			},
		},
	})
	const part: MhtmlPart = { contentId: undefined, location: undefined, mimeType: SIDECAR_MEDIA_TYPE, textEncoding: undefined, data }
	const diagnostics: Diagnostic[] = []

	const parsed = parseSidecarPart(part, diagnostics)
	assert.deepEqual(diagnostics, [])
	assert.equal(parsed?.get('child@archivebridge')?.resourceExtra?.get('SomeFutureAppleResourceKey'), 'resource-level-value')
	assert.equal(parsed?.get('child@archivebridge')?.documentExtra?.get('SomeFutureAppleDocumentKey'), 'document-level-value')
})

// --- plist dictionary prototype poisoning (see plist-dict.ts) ---------------
//
// A metadata sidecar part travels inside an MHTML file, so it is untrusted
// input like everything else in an archive. Its body is a binary plist, which
// means it reaches the same `plist` binary backend whose dictionary assignment
// turns a key literally named `__proto__` into a prototype replacement.
// Sidecar policy is whole-sidecar rejection, so every case below must produce
// `malformed-metadata-sidecar` and leave the surrounding document intact.

/** A plist dictionary with a real own, enumerable `__proto__` key — inexpressible as an object literal, which is why the hazard exists. */
function dictWithProtoKey(protoValue: unknown, ownKeys: Record<string, unknown> = {}): Record<string, unknown> {
	const object: Record<string, unknown> = {}
	Object.defineProperty(object, '__proto__', { value: protoValue, enumerable: true, writable: true, configurable: true })
	return Object.assign(object, ownKeys)
}

function sidecarPartFrom(plistValue: unknown): MhtmlPart {
	// biome-ignore lint/suspicious/noExplicitAny: buildBinary's parameter type cannot express an own `__proto__` key, which is exactly what these tests supply.
	return { contentId: undefined, location: undefined, mimeType: SIDECAR_MEDIA_TYPE, textEncoding: undefined, data: buildBinary(plistValue as any) }
}

test('parseSidecarPart rejects a sidecar whose root dictionary inherits ArchiveBridgeSchemaVersion and resources through a __proto__ plist key', () => {
	const part = sidecarPartFrom(dictWithProtoKey({ ArchiveBridgeSchemaVersion: 1, resources: { 'root@archivebridge': { webResourceFrameName: 'injected' } } }))
	const diagnostics: Diagnostic[] = []

	assert.equal(parseSidecarPart(part, diagnostics), undefined, 'an inherited schema version must never satisfy the version check')
	assert.equal(diagnostics.length, 1)
	assert.equal(diagnostics[0]?.type, 'malformed-metadata-sidecar')
})

test('parseSidecarPart rejects a sidecar whose resources dictionary was poisoned by a __proto__ plist key', () => {
	const part = sidecarPartFrom({ ArchiveBridgeSchemaVersion: 1, resources: dictWithProtoKey({ 'root@archivebridge': { webResourceFrameName: 'injected' } }) })
	const diagnostics: Diagnostic[] = []

	assert.equal(parseSidecarPart(part, diagnostics), undefined)
	assert.equal(diagnostics.length, 1)
	assert.equal(diagnostics[0]?.type, 'malformed-metadata-sidecar')
})

test('parseSidecarPart rejects a sidecar whose resource entry inherits its fields through a __proto__ plist key', () => {
	const part = sidecarPartFrom({
		ArchiveBridgeSchemaVersion: 1,
		resources: { 'root@archivebridge': dictWithProtoKey({ webResourceFrameName: 'injected', webResourceResponse: new Uint8Array([1]) }) },
	})
	const diagnostics: Diagnostic[] = []

	assert.equal(parseSidecarPart(part, diagnostics), undefined)
	assert.equal(diagnostics.length, 1)
	assert.equal(diagnostics[0]?.type, 'malformed-metadata-sidecar')
})

test('parseSidecarPart rejects a sidecar whose resourceExtra/documentExtra was poisoned by a __proto__ plist key', () => {
	for (const key of ['resourceExtra', 'documentExtra']) {
		const part = sidecarPartFrom({
			ArchiveBridgeSchemaVersion: 1,
			resources: { 'root@archivebridge': { [key]: dictWithProtoKey({ WebResourceURL: 'https://injected.invalid/' }) } },
		})
		const diagnostics: Diagnostic[] = []

		assert.equal(parseSidecarPart(part, diagnostics), undefined, `key ${key}`)
		assert.equal(diagnostics.length, 1, `key ${key}`)
		assert.equal(diagnostics[0]?.type, 'malformed-metadata-sidecar', `key ${key}`)
	}
})

test('parseSidecarPart rejects a sidecar dictionary whose __proto__ plist key is null', () => {
	const part = sidecarPartFrom(dictWithProtoKey(null, { ArchiveBridgeSchemaVersion: 1, resources: {} }))
	const diagnostics: Diagnostic[] = []

	assert.equal(parseSidecarPart(part, diagnostics), undefined)
	assert.equal(diagnostics.length, 1)
	assert.equal(diagnostics[0]?.type, 'malformed-metadata-sidecar')
})

test('a poisoned metadata sidecar does not stop the surrounding MHTML document from converting', () => {
	// The load-bearing half of the policy: the sidecar is optional, auxiliary
	// metadata, so a rejected one degrades to "no residual metadata" exactly as if
	// the part were absent — never a failure of the archive around it
	// (docs/architecture.md, "Malformed sidecar").
	const poisonedSidecar = sidecarPartFrom(dictWithProtoKey({ ArchiveBridgeSchemaVersion: 1, resources: {} }))
	const document: MhtmlDocument = { parts: [htmlPart(), poisonedSidecar], rootPartIndex: 0 }

	const { document: webArchive, diagnostics } = convertMhtmlToWebArchive(document)

	assert.equal(webArchive.mainResource.url, 'https://example.invalid/')
	assert.equal(webArchive.mainResource.frameName, undefined, 'no residual metadata is reconstructed from a rejected sidecar')
	assert.equal(webArchive.mainResource.response, undefined)
	assert.deepEqual([...webArchive.mainResource.extra], [])
	// The sidecar-shaped part is still kept out of the page's resource graph.
	assert.deepEqual(webArchive.subresources, [])
	assert.equal(diagnostics.length, 1)
	assert.equal(diagnostics[0]?.type, 'malformed-metadata-sidecar')
})
