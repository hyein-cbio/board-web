# Board Web

**A web UI for [Vercel Board](https://github.com/vercel/board).** It works with any board the `board` CLI can open: point it at your board's `board inspect` and it gives you a fuller reading and writing screen for the same channels, threads, reactions and tasks.

Authentication and the board API go through the local `board inspect` (Inspector) as before. This repository supplies only the screen and a small local server in front of it. There are no build steps and no packages to install.

Built and tested against `@vercel/board` 0.54. It is an independent project, not affiliated with or endorsed by Vercel.

- **Feed**: per-channel threads sorted by recent activity. A message that starts with a heading is shown as a card with a title, excerpt, labels, reactions, and reply count.
- **Reader**: Markdown body, replies (consecutive messages grouped), reactions, attachments, and task status. Your own messages can be edited and deleted.
- **Writing**: compose a new post (Markdown, preview, `key=value` labels) and reply. Drafts persist within the tab.
- **Search and filters**: text search, click a label to filter, tasks by state.
- **Live**: refreshes automatically from the board's event feed. New posts in other channels are marked with a dot.
- Light, dark, and system themes, with a mobile layout. The existing Inspector screen is still available at `/classic`.

## Running

You need Node.js 22.18 or later and the `board` CLI.

1. Run the Inspector on 4748. Add the same `--scope`, `--name`, `--url`, and similar options you normally use.

   ```sh
   board inspect --port 4748 --no-open
   ```

2. Run the following in this repository and open [http://127.0.0.1:4747](http://127.0.0.1:4747) or [http://localhost:4747](http://localhost:4747).

   ```sh
   node server.mjs
   ```

You can change the ports with `PORT` and `INSPECTOR_PORT`. To preview while keeping the server on 4747 running, use `PORT=14747 node server.mjs`. If you restart the Inspector, its token changes; refresh the page when the screen tells you to.

### HTTPS (https://localhost:4747)

Run this once. macOS asks for your password to change trust settings.

```sh
./scripts/setup-https.sh
```

It makes a self-signed certificate that is valid only for `localhost`, `127.0.0.1` and `::1`, stores it in `~/.config/board-web/tls/`, and trusts it in your login keychain. It cannot sign other certificates, so even a leaked key could only impersonate localhost. When the certificate is there, `node server.mjs` answers both http and https on the same port. To use a different certificate, set `TLS_CERT` and `TLS_KEY`. The Inspector (4748) needs no HTTPS: only this server talks to it.

It is valid for 825 days, the longest macOS accepts. Make a new one with `./scripts/setup-https.sh --force`; remove it with:

```sh
security delete-certificate -c "Board Web (localhost)" ~/Library/Keychains/login.keychain-db
rm -r ~/.config/board-web/tls
```

## Keyboard

| Key | Action |
| --- | --- |
| `/` or `⌘K` | Search |
| `N` | New post |
| `J` / `K` | Next / previous thread |
| `R` | Reply |
| `⌘↵` | Post, reply, or save |
| `Esc` | Close menus, editing, and the thread |

## Layout

- [`lib/server.mjs`](lib/server.mjs): serves its own screen at `/`, relays `/board/*` to the Inspector API and `/classic` to the Inspector screen; with a certificate, answers https on the same port
- [`scripts/setup-https.sh`](scripts/setup-https.sh): makes and trusts the localhost certificate
- [`ui/app.js`](ui/app.js): screen logic (routing, feed, reader, writing, live updates)
- [`ui/styles.css`](ui/styles.css): colors, type, and layout. Theme values are gathered in the CSS variables at the top
- [`ui/markdown.js`](ui/markdown.js): Markdown rendering. It escapes everything first and allows only http(s) and mailto links
- [`ui/api.js`](ui/api.js), [`ui/icons.js`](ui/icons.js), [`ui/emoji.js`](ui/emoji.js): API calls, icons, reaction emoji

Files under `ui/` are read on every request, so a page refresh after editing shows the changes. Only `lib/` requires a server restart.

## Security

The Inspector acts with the permissions of the user logged in to the CLI. This server follows the same rules as the Inspector. It listens only on 127.0.0.1, answers only `127.0.0.1:<port>` and `localhost:<port>` addresses (preventing DNS rebinding), and rejects requests that went through a proxy. It refuses writes from other origins, scheme included. The Inspector's per-run token is delivered only to this page. Do not expose either server to the outside.

## Tests

```sh
node --test
```

## License

[MIT](LICENSE)
