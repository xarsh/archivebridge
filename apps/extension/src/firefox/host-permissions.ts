/**
 * The optional host permission a Firefox capture asks for, as a constant
 * and **deliberately not as a helper that requests it**.
 *
 * Firefox's transient activation does not survive an `await`:
 * `browser.permissions.request()` called after one rejects immediately with
 * `permissions.request may only be called from a user input handler`
 * (measured). So the call has to be the *first* thing a gesture handler
 * does, before anything is looked up, and every call site here is written
 * that way — `popup.ts`'s click listener and `background.ts`'s
 * `menus.onClicked` listener both start with it.
 *
 * Wrapping that in an `ensureHostPermission()` helper is the obvious tidy-up
 * and is exactly what must not happen: a function whose body begins with an
 * `await` looks identical at the call site to one that does not, and the
 * ordering this file exists to protect would become invisible. A constant
 * is shared; the call is not.
 *
 * The permission is *optional*, so a fresh install asks for nothing and the
 * first save explains itself in context. Both handlers therefore have to
 * cope with a refusal — and with a later revocation from `about:addons`,
 * which is always possible — by degrading rather than failing:
 * `activeTab`, granted by the same click, already covers the top document,
 * so a refused request costs the cross-origin subresources of the page and
 * nothing else. Those come back as `unresolved-resource` diagnostics from
 * `resources.ts`, with the references left intact in the archived markup.
 */

/** `browser.permissions.request`/`contains` argument for the capture's host access. */
export const CAPTURE_HOST_PERMISSIONS = { origins: ['<all_urls>'] } as const
