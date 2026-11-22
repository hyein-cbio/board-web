# Board Web notes for agents

- No build step and no dependencies: `ui/` is plain ES modules and CSS served as-is; Node.js 22.18+.
- Test: `node --test` (server security/proxy/classic, Markdown escaping).
- Preview without touching the running servers: `PORT=14747 node server.mjs` (the Inspector stays on 4748).
- The Inspector posts as the signed-in user to a real, shared board. Exercise write paths (post, reply, edit, delete, react) against a fake Inspector, not the real one.
- HTTPS: `scripts/setup-https.sh` puts a localhost-only, self-signed certificate in `~/.config/board-web/tls/` (never in the repo) and trusts it in the login keychain; `server.mjs` then serves http and https on the same port.
- The page CSP has no `'unsafe-inline'`: no inline scripts or `style="..."` attributes in markup; set styles through CSSOM or classes.
