# goodnotes-mcp

MCP server that lets an agent view a Goodnotes document live from its share link (`https://web.goodnotes.com/s/...`).

It opens the link in headless Chromium and keeps the tab open, so the Goodnotes web viewer keeps syncing in the background, the same way the link stays in sync on a Mac. Each tool call screenshots the page as it looks right now, handwriting included.

## How it works in a chat

Paste a Goodnotes share link in any chat that has this MCP. The server tells Claude to open it whenever it sees one, so you don't have to ask. Claude then:

- calls `goodnotes_info` to get the page list and when each page was last edited
- views pages with `goodnotes_page` (real images of the page, handwriting and all, not OCR)
- when you say "check what I just wrote", calls `goodnotes_info` again to see which pages changed since it last looked, and re-views those
- for "watch while I write", calls `goodnotes_wait_for_edit`, which returns as soon as you edit something

## Tools

| Tool | Args | Returns |
|---|---|---|
| `goodnotes_info` | `link` | title, page count, each page's last edit time and whether it changed since Claude last viewed it |
| `goodnotes_page` | `link`, `page` (1-based) | image of that page as it looks now, 1267 x 1639 px |
| `goodnotes_wait_for_edit` | `link`, `seconds` (default 50) | which pages changed, once you edit something |

The first page view on a link takes about 20 to 30 s (loading the Goodnotes web app). After that each page takes about 5 to 10 s, mostly waiting for Goodnotes to draw the ink. If the viewer ever misses a sync (the API says a page changed but the image didn't), the server reloads the link on its own.

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

### Remote (custom connector URL)

Set `PORT` and the server speaks Streamable HTTP at `/mcp/<MCP_TOKEN>` instead of stdio. The `Dockerfile` runs it with Playwright's Chromium. Deploy it anywhere that runs Docker with at least ~1 GB RAM, set `MCP_TOKEN` to a long random string, and add `https://<host>/mcp/<MCP_TOKEN>` as a custom connector in Claude.

Set `GOODNOTES_CHROMIUM` to a Chrome or Chromium binary path to use that instead of Playwright's download.

## Notes

- The link must have sharing turned on in Goodnotes. Access is read only.
- Images in the doc show up only once the iPad has uploaded them to Goodnotes' server. Until then the web viewer shows them as missing too.
- A page taller than the viewport (very long custom pages) gets cut off at the bottom.
