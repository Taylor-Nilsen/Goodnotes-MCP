# goodnotes-mcp

MCP server that lets an agent view a Goodnotes document live from its share link (`https://web.goodnotes.com/s/...`).

It opens the link in headless Chromium and keeps the tab open, so the Goodnotes web viewer keeps syncing in the background, the same way the link stays in sync on a Mac. Each tool call screenshots the page as it looks right now, handwriting included.

## Tools

| Tool | Args | Returns |
|---|---|---|
| `goodnotes_info` | `link` | title, page count |
| `goodnotes_page` | `link`, `page` (1-based), `reload` (optional) | JPEG of that page, about 1267 x 1639 px |

The first call on a link takes about 15 s to load the doc. After that each page takes about 5 to 10 s, mostly waiting for Goodnotes to finish drawing the ink.

## Install

Needs Node 18 or newer.

```sh
git clone https://github.com/taylor-nilsen/goodnotes-mcp.git
cd goodnotes-mcp
npm install   # also downloads Playwright's Chromium
```

### Claude Code

```sh
claude mcp add goodnotes -- node /absolute/path/to/goodnotes-mcp/server.mjs
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "goodnotes": {
      "command": "node",
      "args": ["/absolute/path/to/goodnotes-mcp/server.mjs"]
    }
  }
}
```

Set `GOODNOTES_CHROMIUM` to a Chrome or Chromium binary path to use that instead of Playwright's download.

## Notes

- The link must have sharing turned on in Goodnotes. Access is read only.
- Images in the doc show up only once the iPad has uploaded them to Goodnotes' server. Until then the web viewer shows them as missing too.
- A page taller than the viewport (very long custom pages) gets cut off at the bottom.
