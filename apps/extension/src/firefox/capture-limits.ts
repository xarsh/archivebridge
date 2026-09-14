/**
 * What one Firefox capture is allowed to collect.
 *
 * **Why these exist at all.** A page is hostile input (docs/architecture.md,
 * "Capture-side security assumptions"), and a save is one user gesture. Every
 * dimension a page controls — how many resources it references, how large
 * each response is, how many `blob:` URLs it mints and how big they are, how
 * many canvases it has and how many pixels each holds — is a dimension in
 * which one click could otherwise become an arbitrarily large allocation.
 * Bounding them is the same rule the parser already follows for archive
 * bytes ("allocations must not be sized directly from attacker-controlled
 * length fields without a sanity bound"), applied at the other end of the
 * pipeline.
 *
 * **Why they live here and not in `@xarsh/archivebridge/limits.ts`.** That
 * module bounds *archive structures* — frame nesting, `@import` chains —
 * and is read by the parser, so changing one of its constants changes what
 * ArchiveBridge accepts. These bound one browser's capture of a live page.
 * Nothing in the library has an opinion about them, and a shared constant
 * would mean a number chosen for a canvas quietly changed what an archive
 * parses. Same reasoning, separate constants — see that module's own note on
 * why it does not share a bound between frames and stylesheets.
 *
 * **Why two separate byte budgets.** The page-side budget is spent inside
 * the injected capture, in the page's process, on bytes that then cross the
 * world boundary; the network-side budget is spent in the background, on
 * bytes fetched afterwards. Neither can see the other's running total
 * without the injected function reporting back mid-capture, which it has no
 * way to do. Two explicit bounds that each hold on their own side is the
 * honest shape; the archive's worst case is their sum.
 *
 * **Exceeding a limit is never a failed save.** It drops the one resource
 * that crossed it, leaves the markup reference alone, and reports a
 * diagnostic — the same "degrade, do not fail outright" policy the rest of
 * the capture follows.
 *
 * **What these numbers do and do not promise.** They bound what a capture
 * *collects*: how many resources it will ask for, how many bytes one of
 * them may contribute, how many it keeps in total, how many canvases it will
 * try to snapshot and how large a bitmap it will encode. They are not a
 * statement about peak JS heap, and the code deliberately does not pretend
 * to be one: a bounded body read accumulates chunks and then concatenates
 * them into one array of the same total, so a resource that ends up at the
 * per-resource ceiling passes transiently through something closer to twice
 * it, and a canvas exists briefly as base64 text and as decoded bytes at
 * once. Making the peak exact would mean sizing one buffer up front from a
 * length the page or the server chose — the very thing the parser's own
 * rule forbids ("allocations must not be sized directly from
 * attacker-controlled length fields"). So the guarantee is the one that
 * actually holds against a hostile page: no dimension the page controls
 * grows without limit, and what a capture retains is bounded exactly.
 */

/**
 * Upper bound on the referenced resources one capture will fetch. A page can
 * reference arbitrarily many; a save is user-initiated and should end.
 */
export const MAX_NETWORK_RESOURCES = 500

/**
 * Upper bound on distinct `blob:` URLs read out of the page. Lower than the
 * network bound because a blob is *minted* by the page rather than merely
 * referenced by it: `URL.createObjectURL` in a loop is the cheapest way a
 * page has to ask the capture for memory, and Phase 1's blob scope (an
 * `<img src>` or a stylesheet `href`) makes a hundred already generous.
 */
export const MAX_BLOB_RESOURCES = 100

/**
 * Upper bound on one resource's bytes, network or blob. Comfortably above
 * any image or stylesheet a page legitimately loads, and far below the point
 * where a single response could exhaust the process.
 */
export const MAX_RESOURCE_BYTES = 32 * 1024 * 1024

/**
 * Upper bound on everything the background fetches for one capture, across
 * all resources. Reached by a page with many large resources rather than one
 * enormous one, which {@link MAX_RESOURCE_BYTES} alone would not catch.
 */
export const MAX_NETWORK_BYTES = 128 * 1024 * 1024

/** Upper bound on the bytes the injected capture returns across the world boundary: every canvas's pixels plus every blob's contents. */
export const MAX_PAGE_CAPTURED_BYTES = 64 * 1024 * 1024

/**
 * Upper bound on how many `<canvas>` elements the capture will *try* to
 * snapshot. Beyond it a canvas stays an ordinary (empty) `<canvas>` in the
 * archive, with no `toDataURL` call made for it.
 *
 * Attempts rather than successful snapshots, because a page chooses how
 * many of its canvases fail: one whose bitmap cannot be read, or that is
 * past {@link MAX_CANVAS_PIXELS}, or that is offered after the capture's
 * byte budget is spent, produces no snapshot at all, and a bound counted in
 * snapshots would let a page have arbitrarily many of those attempted.
 */
export const MAX_CANVASES = 64

/**
 * Upper bound on a canvas's bitmap area, checked **before** `toDataURL` is
 * called rather than after: encoding is where the allocation happens (four
 * bytes per pixel live, plus a PNG and its base64 text), so a bound applied
 * to the result would be applied too late. 16 megapixels is several times
 * any canvas a page actually renders on screen, and two orders of magnitude
 * below the 472-megapixel area Firefox itself will allocate.
 */
export const MAX_CANVAS_PIXELS = 16 * 1024 * 1024

/**
 * The page-side limits, in the shape {@link capturePageState} takes them.
 *
 * Passed in as an argument rather than read from this module by the injected
 * function, which cannot import anything — see `page-capture.ts`. Exported
 * as one object so `capture.ts` and the Firefox E2E lane inject the same
 * numbers without either restating them.
 */
export const PAGE_CAPTURE_LIMITS = {
	maxNetworkResources: MAX_NETWORK_RESOURCES,
	maxBlobResources: MAX_BLOB_RESOURCES,
	maxResourceBytes: MAX_RESOURCE_BYTES,
	maxCapturedBytes: MAX_PAGE_CAPTURED_BYTES,
	maxCanvases: MAX_CANVASES,
	maxCanvasPixels: MAX_CANVAS_PIXELS,
} as const

/** The network-side limits, in the shape `acquireResources` takes them. */
export const RESOURCE_FETCH_LIMITS = {
	maxResourceBytes: MAX_RESOURCE_BYTES,
	maxTotalBytes: MAX_NETWORK_BYTES,
} as const
