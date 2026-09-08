import assert from 'node:assert/strict'
import test from 'node:test'
import { detectArchiveFormatFromBytes, detectArchiveFormatFromFilename } from './detect.ts'

test('detectArchiveFormatFromFilename recognizes .mhtml', () => {
	assert.equal(detectArchiveFormatFromFilename('page.mhtml'), 'mhtml')
})

test('detectArchiveFormatFromFilename recognizes .mht', () => {
	assert.equal(detectArchiveFormatFromFilename('page.mht'), 'mhtml')
})

test('detectArchiveFormatFromFilename recognizes .webarchive', () => {
	assert.equal(detectArchiveFormatFromFilename('page.webarchive'), 'webarchive')
})

test('detectArchiveFormatFromFilename is case-insensitive', () => {
	assert.equal(detectArchiveFormatFromFilename('PAGE.MHTML'), 'mhtml')
})

test('detectArchiveFormatFromFilename returns undefined for unknown extensions', () => {
	assert.equal(detectArchiveFormatFromFilename('page.html'), undefined)
})

test('detectArchiveFormatFromBytes recognizes binary plist magic', () => {
	const bytes = new TextEncoder().encode('bplist00\x00\x00\x00')
	assert.equal(detectArchiveFormatFromBytes(bytes), 'webarchive')
})

test('detectArchiveFormatFromBytes recognizes XML plist WebArchive', () => {
	const xml = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0"><dict/></plist>',
	].join('\n')
	assert.equal(detectArchiveFormatFromBytes(new TextEncoder().encode(xml)), 'webarchive')
})

test('detectArchiveFormatFromBytes recognizes MHTML starting with From:', () => {
	const mhtml = 'From: <Saved by ArchiveBridge>\nMIME-Version: 1.0\n'
	assert.equal(detectArchiveFormatFromBytes(new TextEncoder().encode(mhtml)), 'mhtml')
})

test('detectArchiveFormatFromBytes recognizes MHTML starting with MIME-Version:', () => {
	const mhtml = 'MIME-Version: 1.0\nContent-Type: multipart/related; boundary=x\n'
	assert.equal(detectArchiveFormatFromBytes(new TextEncoder().encode(mhtml)), 'mhtml')
})

test('detectArchiveFormatFromBytes returns undefined for unrelated content', () => {
	const html = '<!DOCTYPE html><html><body>hi</body></html>'
	assert.equal(detectArchiveFormatFromBytes(new TextEncoder().encode(html)), undefined)
})
