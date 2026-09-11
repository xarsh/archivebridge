/**
 * The isolation the viewer imposes on archived content: one `sandbox`
 * attribute and one Content Security Policy, written down in one place
 * with the reason for every capability that is present and — more
 * importantly — every one that is not.
 *
 * The shape being enforced:
 *
 * ```text
 * viewer page (chrome-extension://…/viewer.html)
 *   │  privileged: reads the local file, mints resource URLs
 *   ▼
 * reconstructed archive document (blob:chrome-extension://…)
 *   │  hard boundary: sandbox + CSP
 *   ▼
 * nested archived frames (blob:…), each at least as sandboxed
 * ```
 *
 * Browser-neutral on purpose: `sandbox` and CSP are web platform features,
 * not Chrome ones, so a Firefox or Safari viewer imposes the same policy
 * from the same constants. Only *where* the policy is declared differs
 * (Chrome puts the CSP in `manifest.json`'s `content_security_policy.
 * extension_pages`, which a blob: or srcdoc document inherits from the
 * extension page that created it — measured).
 */

/**
 * The `sandbox` value for the frame that renders archived content.
 *
 * **`allow-same-origin` is the only token, and it is not casual.** It is
 * there for exactly one reason: a document with an opaque origin cannot
 * load a `blob:` URL minted by the extension — Chromium refuses with "Not
 * allowed to load local resource" (measured, Chromium 153). Without it,
 * every archived image, stylesheet, font and nested frame would have to be
 * inlined as a `data:` URL instead, which means base64-inflating every
 * byte of a multi-megabyte capture into the document text and giving up
 * any way to release those bytes afterwards.
 *
 * What makes that trade sound is what is *absent*:
 *
 * - **No `allow-scripts`.** Nothing in the archive can execute, so nothing
 *   can act on the origin the frame has. Inline handlers, `javascript:`
 *   URLs, `<script>` bodies and `meta refresh` are all inert as a result
 *   (measured), on top of being rewritten away by `renderMhtml`. This is
 *   also why the notorious `allow-scripts allow-same-origin` combination —
 *   which lets a frame remove its own sandbox — cannot arise here.
 * - **No `allow-forms`**, so a form cannot submit even if one is clicked.
 * - **No `allow-top-navigation`/`-by-user-activation`**, so archived
 *   markup cannot navigate the viewer tab (measured: Chromium refuses,
 *   naming the missing flag).
 * - **No `allow-popups`**, so a `target=_blank` link cannot open anything.
 * - **No `allow-modals`, `allow-downloads`, `allow-pointer-lock`,
 *   `allow-presentation`, `allow-orientation-lock`,
 *   `allow-popups-to-escape-sandbox`, `allow-storage-access-by-user-
 *   activation`.** None of them is needed to lay out a saved page.
 *
 * Sandbox flags are inherited by nested browsing contexts and can only be
 * narrowed, never widened, so an archived `<iframe sandbox="allow-scripts">`
 * inside this frame gains nothing.
 */
export const ARCHIVE_FRAME_SANDBOX = 'allow-same-origin'

/**
 * The extension's Content Security Policy, applying to every extension
 * page *and*, by inheritance, to the reconstructed archive documents those
 * pages create as `blob:` URLs (measured).
 *
 * Read as "what may this document load, and from where":
 *
 * - `default-src 'none'` — nothing, unless a directive below says
 *   otherwise. That is what covers the fetch destinations nobody thinks to
 *   name (`prefetch`, `manifest`, `worker`, `connect` from a context that
 *   should not connect).
 * - `script-src 'self'` — the extension's own scripts/bundles, and nothing
 *   else. No `'unsafe-inline'`, no `'unsafe-eval'`, no remote script. The
 *   archive frame has no scripting at all, so this only ever admits
 *   ArchiveBridge's own code.
 * - `style-src 'unsafe-inline'` — an archived page's `<style>` blocks and
 *   `style=` attributes are the substance of how it looks, and there is no
 *   way to hash or nonce content that arrives at runtime. Note the absence
 *   of `'self'`: archived markup cannot pull in the extension's own files.
 *   Archived *external* stylesheets arrive as `blob:` URLs, which Chromium
 *   admits for style regardless of this list (measured) and which
 *   `img-src`/`font-src` name explicitly for their own destinations.
 * - `img-src`, `font-src`, `media-src` — `blob:` for archived resources
 *   the viewer minted, `data:` for references the archive carries inline.
 *   Neither can reach a network. **`img-src` is the one directive the
 *   viewer genuinely depends on**, rather than holding in reserve: a bare
 *   `<string>` in `image-set()` is a URL, and CSS custom properties can
 *   carry that string in from anywhere in the cascade
 *   (`:root{--x:"https://…"}` plus `image-set(var(--x) 1x)` loads it —
 *   measured, Chromium 153). Whether `--x` is a URL is a question about
 *   custom-property substitution rather than about any stylesheet's text,
 *   so `renderMhtml` cannot neutralize it without evaluating the cascade,
 *   and this is what stops it. See docs/architecture.md, "The security
 *   contract, as rules", rule 1.
 * - `frame-src blob:` — reconstructed frame documents only. Measured to
 *   cover a frame navigating *itself*, which is the one navigation the
 *   sandbox flags do not.
 * - `object-src 'none'` — plugin content never loads, in addition to being
 *   rewritten away.
 * - `connect-src file:` — the viewer reading the local archive it was
 *   asked to open. Nothing else, and no `'self'`.
 * - `form-action 'none'` and `base-uri 'none'` — a second and third
 *   mechanism behind the rewrite for the two things that would otherwise
 *   take a reader off the archive (measured: Chromium blocks an archived
 *   `<base href>` under this policy).
 *
 * A CSP is the backstop, not the plan: `renderMhtml` has already
 * neutralized every statically identifiable reference, precisely because
 * some escapes — `<link rel=preconnect>` above all — are governed by no
 * fetch directive at all. The one exception is named under `img-src`
 * above, and it is stated rather than smoothed over: for a URL whose
 * meaning is synthesized only by CSS custom-property substitution, this
 * policy is not a second line of defence but the only one.
 */
export const EXTENSION_PAGES_CSP = [
	"default-src 'none'",
	"script-src 'self'",
	"style-src 'unsafe-inline'",
	'img-src blob: data:',
	'font-src blob: data:',
	'media-src blob: data:',
	'frame-src blob:',
	"object-src 'none'",
	'connect-src file:',
	"form-action 'none'",
	"base-uri 'none'",
].join('; ')
