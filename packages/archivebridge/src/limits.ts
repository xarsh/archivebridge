/**
 * Recursion bound for frame structures: WebArchive's `WebSubframeArchives`
 * nesting while parsing, and MHTML's `cid:`-linked frame-root chain while
 * flattening/reconstructing during conversion. Malformed or adversarial
 * input must not cause unbounded recursion — see
 * docs/architecture.md#security-assumptions. Exceeding this depth is a
 * `frame-depth-exceeded` diagnostic, not a hang or a stack overflow.
 */
export const MAX_FRAME_DEPTH = 32

/**
 * Recursion bound for a stylesheet's `@import` chain while the viewer
 * reconstructs it (`view/render.ts`).
 *
 * **Why this is not {@link MAX_FRAME_DEPTH}.** The two bound different
 * structures for different reasons. `MAX_FRAME_DEPTH` is a property of the
 * *archive formats* — WebArchive's `WebSubframeArchives` nesting and
 * MHTML's `cid:`-linked frame chains — and it is read by the parser and the
 * converter, so changing it changes what parsing accepts. An `@import`
 * chain is none of those things: it exists only inside stylesheet text, it
 * is reached only by the viewer, and nothing outside `view/` has an opinion
 * about it. Sharing one constant would mean a change made for frame nesting
 * silently changed CSS reconstruction, which is exactly the coupling a named
 * limit is supposed to prevent.
 *
 * **Why 16.** Memoization already makes a *cyclic* chain terminate and a
 * diamond graph linear (each stylesheet part is rewritten at most once), so
 * this bound exists for the remaining case: an acyclic chain through
 * thousands of distinct parts, which is cheap to put in a hostile archive
 * and which recurses once per link. Measured: such a chain overflows the
 * JavaScript stack at roughly 2000 parts and reconstructs fine at 1000, so
 * anything in the low hundreds would be safe. 16 is chosen from the other
 * end instead — real stylesheets nest `@import` a handful of levels at
 * most, so this is several times the deepest plausible genuine chain while
 * staying two orders of magnitude below where recursion becomes a problem.
 * Chromium itself is no help in picking a number: it followed a chain past
 * 4000 sheets without stopping (measured, Chromium 153).
 *
 * Exceeding it makes that one `@import` non-loadable and produces a
 * `stylesheet-import-depth-exceeded` render warning; the stylesheet
 * containing it is still reconstructed, and so is everything above it.
 */
export const MAX_STYLESHEET_IMPORT_DEPTH = 16
