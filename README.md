# Brightspace MCP Server — Entra ID SSO Fork

This is a local fork of [RohanMuppa/brightspace-mcp-server][upstream] adapted for
Brightspace (D2L) installations that delegate authentication to **Microsoft
Entra ID** (Azure AD) — notably most Canadian post-secondary Brightspace
tenants, where organization policy typically enforces weekly interactive
re-authentication with MFA.

[upstream]: https://github.com/RohanMuppa/brightspace-mcp-server

The upstream project is written against Purdue's Shibboleth/Duo SSO. It has
hard-coded references to Purdue's identity provider and a hardcoded
`handleCampusSelector()` in the auth flow that hijacks any `/d2l/login` URL
and points it at `idp.purdue.edu`. That is fine at Purdue, but it breaks at
every other institution.

## What this fork changes

1. **New SSO provider abstraction** (`SSOProviderFlow`). The existing
   `PurdueSSOFlow` is now one implementation of that interface, and a new
   `EntraSSOFlow` is added for headed Microsoft Entra ID login.
2. **`ssoProvider` config field**, selecting between:
   - `"entra"` — headed Microsoft Entra ID login, **default in this fork**.
   - `"purdue"` — upstream Purdue Shibboleth automation.
   - `"manual"` — generic manual login with no IdP-specific hooks.
3. **Provider selection in `BrowserAuth`** — no more hardcoded Purdue
   references in the common auth path.
4. **Robust redirect detection in `navigateAndLogin()`**. Many Brightspace
   tenants serve a tiny JS stub at `/d2l/home` that immediately calls
   `window.location.replace('/d2l/login...')`. The upstream code checked
   `page.url()` too early and thought it was already authenticated. The
   new flow waits for the URL to settle on either the real Brightspace home
   or a known login surface (Microsoft login, SAML initiate, IdP, etc.)
   before deciding.
5. **Dedicated `brightspace-entra-auth` CLI**. Opens a visible Chromium
   window, lets the user complete Entra ID login interactively, captures a
   usable D2L API token (via Bearer interception, localStorage, XSRF, or
   session-cookie fallback), and persists the session.
6. **Accurate session-expiry UX in the MCP server**. The original server
   tries to auto-spawn the auth CLI when the token expires. That cannot
   work inside Claude Desktop — there is no terminal and no way to show a
   browser window. The Entra fork disables auto-reauth for `entra` and
   `manual` providers and instead returns a clear, actionable error message
   telling the user to run `brightspace-entra-auth` in a terminal.
7. **7-day default `tokenTtl`** for `entra`, matching the typical Entra
   conditional-access re-authentication window (configurable per install).
8. **Instructor attachment support on assignments.** `get_assignments` now
   returns an `attachments` array for each dropbox folder with the
   instructor-uploaded files attached to the assignment description
   (project specs, starter-code archives, rubric handouts, etc.), read
   directly from the folder's `Attachments` field on the D2L list
   endpoint. `download_file` accepts a new `attachmentId` parameter
   (mutually exclusive with `fileId`) that hits
   `GET /d2l/api/le/<ver>/<ou>/dropbox/folders/<folderId>/attachments/<attachmentId>`
   and writes the file through the same secure-download pipeline used for
   course content and student submissions. A `linkAttachments` array is
   also surfaced for assignments that attach URL links instead of files.
9. **Extended MIME allowlist.** The downloader's magic-byte allowlist now
   covers 7-Zip (`application/x-7z-compressed`), gzip, tar, and bzip2
   archives in addition to the upstream ZIP entry, so `.7z` starter-code
   archives and the like can be downloaded without tripping the safety
   check.

Nothing is removed. Purdue's automated flow still works if you set
`"ssoProvider": "purdue"` in `~/.brightspace-mcp/config.json` and supply
`username` / `password`.

## Prerequisites

- Node.js 18+
- The repository checked out into a local directory
- `npm install` run once (this downloads Playwright's Chromium)

```sh
cd /path/to/d2l-mcp
npm install
npm run build
```

## Config file

The server reads `~/.brightspace-mcp/config.json`. For an Entra-backed
Brightspace tenant, create it like this (no username or password — those
are deliberately left out; Entra login is interactive):

```json
{
  "baseUrl": "https://yourschool.desire2learn.com",
  "ssoProvider": "entra",
  "headless": false,
  "tokenTtl": 604800
}
```

Fields:

| Field          | Meaning                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `baseUrl`      | The root URL of your institution's Brightspace tenant. Include `https://`.                                                                                   |
| `ssoProvider`  | `"entra"` for Microsoft Entra ID (default), `"purdue"` for Purdue Shibboleth, `"manual"` for a generic manual flow.                                          |
| `headless`     | Whether to run Chromium headless. Must be `false` for `entra`/`manual` — the user has to type their own credentials.                                         |
| `tokenTtl`     | How long (seconds) the MCP server treats the captured token as valid. Default for `entra` is 7 days (`604800`). This does **not** extend Entra's real policy. |
| `sessionDir`   | Optional. Where to store captured sessions. Defaults to `~/.d2l-session`.                                                                                    |
| `includeCourses` / `excludeCourses` / `activeOnly` | Optional filtering, same semantics as upstream.                                                          |

Environment variables (`D2L_BASE_URL`, `D2L_SSO_PROVIDER`, `D2L_HEADLESS`,
`D2L_TOKEN_TTL`, `D2L_SESSION_DIR`, `D2L_INCLUDE_COURSES`,
`D2L_EXCLUDE_COURSES`, `D2L_ACTIVE_ONLY`) override the config file if set.

## Authenticating

From a terminal (NOT from inside Claude Desktop), run:

```sh
npm run entra-auth
```

or, if the package is globally installed:

```sh
brightspace-entra-auth
```

A Chromium window will open. Sign in with your organization account
(username → password → MFA / conditional access). Do not close the window;
the CLI will close it automatically once Brightspace finishes loading and
a usable session token has been captured. The encrypted session is saved
to `~/.d2l-session/session.json`.

**The first time** you run this, the Chromium persistent profile is seeded
with your sign-in cookies. On subsequent runs, if Entra's cookies are still
valid, you may not even need to re-enter credentials — Chromium will just
sail through. When they are *not* valid, you will see the Microsoft login
page again.

## Session expiry and re-authentication

Most Canadian post-secondary Entra tenants enforce a **7-day** re-auth
window via conditional access. When that window elapses you will see one
of these:

- `check_auth` reports: *"Not authenticated with Brightspace ... Auto-reauthentication is disabled for ssoProvider=\"entra\" — the sign-in flow needs a visible browser window and cannot run inside Claude Desktop. Open a terminal and run `brightspace-entra-auth`..."*
- Any other tool (`get_my_courses`, `get_my_grades`, etc.) fails with the
  same message.

The fix is always the same: open a terminal and run `brightspace-entra-auth`.
The MCP server in Claude Desktop will pick up the new session automatically
on the next tool call — no restart needed.

This is an intentional design choice. The upstream `AuthRunner` spawns the
auth CLI as a subprocess, which would try to open a Chromium window from
inside the Claude Desktop process. That window would be invisible (no
parent terminal, no user-facing UI), and the user would have no way to
complete the Entra login. Failing loudly with a clear instruction is
better than failing silently forever.

## Claude Desktop configuration

Add an entry to `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS), using the absolute path to the local fork's `build/index.js`:

```json
{
  "mcpServers": {
    "brightspace": {
      "command": "node",
      "args": ["/absolute/path/to/d2l-mcp/build/index.js"]
    }
  }
}
```

Then restart Claude Desktop. The server will read `~/.brightspace-mcp/config.json`
on startup.

## Troubleshooting

- **Chromium didn't open.** Run `npx playwright install chromium` once.
- **"Could not discover API versions"** on startup. The server calls
  `/d2l/api/versions/` at boot. If Brightspace is up but returning HTML
  (e.g. because the tenant is in maintenance), check the URL in a browser.
- **The auth flow reached `/d2l/home` but no token was captured.** The
  token is captured via several strategies in order: Bearer in
  `localStorage["D2L.Fetch.Tokens"]`, passive network interception of
  requests carrying `Authorization: Bearer`, D2L's XSRF token from page
  context, and finally session-cookie auth (the `accessToken` is prefixed
  with `cookie:` and sent as a `Cookie` header). If none of these succeed,
  the session is unusable and `brightspace-entra-auth` exits with an error.
- **You actually want the Purdue flow.** Set `"ssoProvider": "purdue"` in
  `config.json` and supply `username` / `password`. Nothing Purdue-specific
  was removed.

## Credit

All Brightspace-specific logic (API client, tools, token management, cache,
rate limiter, etc.) is from Rohan Muppa's upstream project. This fork only
adjusts the auth layer to support institutions that use Microsoft Entra ID
SSO and cannot auto-reauthenticate from inside Claude Desktop.
