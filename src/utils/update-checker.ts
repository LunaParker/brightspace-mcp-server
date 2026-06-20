/**
 * Update checker — DISABLED in this fork.
 *
 * The upstream implementation queried the npm registry for
 * `brightspace-mcp-server` and, on ANY version mismatch, ran
 * `npm install -g brightspace-mcp-server@latest`. Because this fork shared the
 * upstream's npm name, that logic reinstalled (and even downgraded to) the
 * upstream package over this fork's global install — wiping the Entra auth
 * code on 2026-06-19. This fork is maintained via git (origin/main), not npm,
 * so the background auto-updater is intentionally a no-op.
 *
 * Do NOT re-enable this. If you want a manual, git-based update, use
 * `npm run update` (see src/update.ts), which pulls from origin/main.
 */

export function initUpdateChecker(): void {
  // Intentionally does nothing. See file header.
}

export function getUpdateNotice(): string | null {
  return null;
}
