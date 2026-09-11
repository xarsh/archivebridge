/**
 * Turns "the user double-clicked a `.webarchive`" into "an ArchiveBridge
 * viewer tab", on Chrome/Edge.
 *
 * Chrome will not render a `.webarchive`: the navigation never commits,
 * `downloads.onCreated` fires with `mime=application/x-webarchive`, and
 * the tab is destroyed (measured). The one hook that runs *before* that
 * download decision is `declarativeNetRequest`, which — surprisingly, and
 * unlike `webRequest` on Firefox — does see `file://` main-frame
 * navigations and can redirect them. That single fact is what makes the
 * whole viewer reachable from a double-click with no native companion.
 *
 * Everything about the rule below is measured against Chromium 153:
 *
 * - **The rule is dynamic, not static.** `regexSubstitution` has to name
 *   the viewer with an absolute URL, and an unpacked extension's own
 *   origin is not knowable until it is installed — so the substitution is
 *   built from `chrome.runtime.getURL()` at startup. A static
 *   `rule_resources` entry with a relative substitution is accepted and
 *   then simply never matches. `redirect.extensionPath` is the obvious
 *   escape from needing the extension ID, and it cannot do this job:
 *   substitution is a `regexSubstitution` feature only, so an
 *   `extensionPath` of `/viewer.html#\0` is accepted and lands on
 *   `viewer.html#\0` with the `\0` **literal** — no source URL, and the
 *   viewer has nothing to open. A static ruleset is therefore not an
 *   option while the archive's location travels in the URL.
 * - **`host_permissions: ["file:///*"]` is required.** A `redirect` action
 *   needs host permission for the request URL; without it the rule is
 *   installed, reports no error, and the navigation downloads as before.
 * - **The source URL travels in the fragment.** See
 *   `core/viewer-source.ts`: `\0` inserts the matched URL verbatim, and a
 *   file name containing `&`, `=` or `+` would break a query parameter.
 * - **`main_frame` only.** A `.webarchive` referenced as a subresource or
 *   framed by a page is left entirely alone: turning that into a viewer
 *   would let a web page host archived content inside itself, which is
 *   the opposite of the isolation the viewer exists to provide.
 * - **`isUrlFilterCaseSensitive: false`** is set rather than relied on, so
 *   `.WEBARCHIVE` matches whatever the default becomes.
 * - **No loop is possible**: the redirect target is a
 *   `chrome-extension://` URL, which cannot match `^file:///`, and the
 *   viewer reads the archive with `fetch` (an `xmlhttprequest` request),
 *   not with a main-frame navigation.
 *
 * What is deliberately *not* intercepted: `.mht`/`.mhtml`, which Chrome
 * renders natively and more inertly than any extension viewer could
 * (docs/architecture.md, "Security constraints the viewer must satisfy"),
 * and every other `file://` URL.
 */

/**
 * `.webarchive` at the very end of a `file:///` URL. `$`-anchored so
 * `notes.webarchive.txt` does not match; DNR matches against the URL with
 * its fragment removed, so a `#` in the file name (which Chromium
 * percent-encodes anyway) cannot slip past the anchor.
 */
const LOCAL_WEBARCHIVE_PATTERN = String.raw`^file:///.*\.webarchive$`

/** The dynamic rule's id. Fixed, so re-registering replaces rather than accumulates. */
const RULE_ID = 1

/**
 * The viewer page the redirect lands on.
 *
 * **It is deliberately not a `web_accessible_resources` entry, and the
 * reason is narrower than "extensions shouldn't expose pages".** Chrome's
 * `declarativeNetRequest` documentation says a rule "cannot redirect from a
 * public resource request to a resource that is not web accessible", and
 * the `web_accessible_resources` page says "a navigation from a web origin
 * to an extension resource is blocked unless the resource is listed as web
 * accessible". Both qualifiers matter here, because the navigation this
 * rule redirects is neither: Chromium's own navigation throttle
 * (`extensions/browser/extension_navigation_throttle.cc`) returns `PROCEED`
 * before any accessibility check when the navigation has no initiator
 * origin — "browser-initiated navigations without an initiator origin
 * happen when a user directly triggers navigation (e.g. using the omnibox,
 * or the bookmark bar)". Double-clicking a `.webarchive`, or typing its
 * `file://` URL, is exactly that case. So this is documented behavior
 * rather than a loophole, and it is what the product flow depends on.
 *
 * All measured against Chromium 153 with this extension unpacked:
 *
 * - A browser-initiated `file:///….webarchive` navigation reaches the
 *   viewer and renders. (The whole viewer E2E lane is this case.)
 * - A web page cannot navigate to `viewer.html`, frame it, or navigate to a
 *   `file://` archive — all three are refused, so no web origin can reach
 *   the viewer or feed it an archive.
 * - **The known limit:** a *click on a link in a local HTML page* has a
 *   `file://` initiator origin, so it is not browser-initiated and Chrome
 *   refuses it with an error page. Opening the archive directly works;
 *   linking to it from another local file does not. Adding
 *   `web_accessible_resources: [{ resources: ["viewer.html"], matches:
 *   ["file:///*"] }]` was measured to fix exactly that case while leaving
 *   all three web-origin attempts above still refused — so the common
 *   worry that declaring a web-accessible resource would let any web page
 *   frame the viewer is *not* true for an origin-scoped `matches` list.
 *   It is left undeclared regardless: the double-click flow does not need
 *   it, and not declaring it is the smaller surface.
 *
 * Not verified: whether a packed/store installation behaves identically.
 * The throttle path above does not consult install location, but this was
 * not tested against a CRX install, which `--load-extension` cannot do.
 */
const VIEWER_PAGE = 'viewer.html'

/**
 * Builds the rule for a given viewer URL.
 *
 * Kept module-private on purpose. The E2E suite checks this rule by asking
 * *Chrome* for its dynamic rules and comparing them against literal
 * expected values — comparing them against this function instead would
 * only prove the source agrees with itself.
 */
function localWebArchiveRule(viewerUrl: string): ChromeDeclarativeNetRequestRule {
	return {
		id: RULE_ID,
		priority: 1,
		action: { type: 'redirect', redirect: { regexSubstitution: `${viewerUrl}#\\0` } },
		condition: { regexFilter: LOCAL_WEBARCHIVE_PATTERN, isUrlFilterCaseSensitive: false, resourceTypes: ['main_frame'] },
	}
}

/**
 * Installs (or replaces) the interception rule.
 *
 * Dynamic rules persist across browser restarts and extension updates, so
 * this is idempotent by design rather than by luck: `removeRuleIds` clears
 * whatever a previous version of this extension registered under the same
 * id before the current definition goes in. Registering on every service
 * worker start would be wasteful; registering only on install would leave
 * an extension whose rule was somehow lost with no way back, so it runs on
 * both `onInstalled` and `onStartup` — the same two events the context
 * menus use.
 */
export async function installFileInterception(): Promise<void> {
	await chrome.declarativeNetRequest.updateDynamicRules({
		removeRuleIds: [RULE_ID],
		addRules: [localWebArchiveRule(chrome.runtime.getURL(VIEWER_PAGE))],
	})
}
