/**
 * Recursion bound for frame structures: WebArchive's `WebSubframeArchives`
 * nesting while parsing, and MHTML's `cid:`-linked frame-root chain while
 * flattening/reconstructing during conversion. Malformed or adversarial
 * input must not cause unbounded recursion — see
 * docs/architecture.md#security-assumptions. Exceeding this depth is a
 * `frame-depth-exceeded` diagnostic, not a hang or a stack overflow.
 */
export const MAX_FRAME_DEPTH = 32
