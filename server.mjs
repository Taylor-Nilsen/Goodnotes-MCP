#!/usr/bin/env node
// MCP server: view a Goodnotes share link live. Keeps one headless Chromium tab per link open,
// so the Goodnotes web app keeps syncing in the background, and screenshots pages on demand.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import http from 'node:http';
import { chromium } from 'playwright';
import { z } from 'zod';

const LINK = /^https:\/\/web\.goodnotes\.com\/s\/[A-Za-z0-9_-]+$/;
const TOOLBAR = 48; // px, height of the Goodnotes top bar; pages scroll to sit right under it
// Page about 1210 x 1570 px, which Claude can read without downscaling.
const VIEWPORT = { width: 1270, height: 1720 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
const tabs = new Map(); // link -> Promise<Page>

async function openTab(link) {
  browser ??= await chromium.launch({
    executablePath: process.env.GOODNOTES_CHROMIUM || undefined,
    args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: VIEWPORT, colorScheme: 'light' });
  await page.goto(link);
  await page.waitForSelector('#pageIndicator', { timeout: 90_000 });
  await page.waitForSelector('canvas.layer', { timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  return page;
}

async function getTab(link) {
  if (!LINK.test(link)) throw new Error(`Not a Goodnotes share link: ${link}`);
  if (!tabs.has(link)) tabs.set(link, openTab(link).catch((e) => { tabs.delete(link); throw e; }));
  const page = await tabs.get(link);
  await dismissPopups(page);
  return page;
}

// The cookie banner and "Open in app?" dialog pop up at random times and cover the page.
async function dismissPopups(page) {
  for (const text of ['Continue in browser', 'Accept all']) { // dialog first, it can sit over the banner
    const btn = page.getByText(text, { exact: true });
    if (await btn.isVisible().catch(() => false)) await btn.click({ timeout: 3000 }).catch(() => {});
  }
}

// Jump to page n via the thumbnail sidebar (the canvas itself only scrolls by mouse wheel, imprecisely).
// Closing the sidebar leaves the page fit-to-width with its top right under the toolbar.
async function goToPage(page, n) {
  const toggle = page.locator('button').nth(1); // sidebar button, right of the title
  await toggle.click();
  await page.locator(`[data-testid=sidebarThumbnail_${n - 1}]`).click();
  await toggle.click();
  await page.waitForTimeout(300);
  const rect = await page.evaluate((top) => {
    const rs = [...document.querySelectorAll('canvas.layer')].map((c) => c.getBoundingClientRect());
    return rs.find((r) => Math.abs(r.y - top) < 2 && r.height > 50) ?? rs[0];
  }, TOOLBAR);
  // ponytail: a page taller than the viewport gets cut off at the bottom; scroll and stitch if that matters.
  const clip = { x: rect.x, y: rect.y, width: rect.width, height: Math.min(rect.height, VIEWPORT.height - rect.y) };
  // The page shows blank white (about 10 KB as PNG) for a few seconds, then the content renders.
  // Wait until it is non-blank and has stopped changing. A truly blank page just runs out the timer.
  let prev;
  for (const end = Date.now() + 20_000; Date.now() < end; await sleep(500)) {
    await dismissPopups(page);
    const png = await page.screenshot({ clip });
    if (png.length > 30_000 && prev?.equals(png)) break;
    prev = png;
  }
  return clip;
}

// Goodnotes' public share API: title plus page ids in order, each with its last-edit time.
async function docInfo(link) {
  if (!LINK.test(link)) throw new Error(`Not a Goodnotes share link: ${link}`);
  const id = link.split('/').pop();
  const res = await fetch(`https://api.goodnotes.com/v3/documents/${id}`).catch(() => null);
  const body = await res?.json().catch(() => null);
  if (body?.type !== 'Ok') throw new Error('Link is not shared (sharing turned off or link deleted). Ask for a fresh share link.');
  const { title, pageIds, pages } = body.document;
  return { title, pages: pageIds.map((pid, i) => ({ page: i + 1, id: pid, lastModified: pages[pid]?.lastModified ?? 0 })) };
}

const seen = new Map(); // `${link} ${pageId}` -> { lastModified, jpg } from the last screenshot of that page

// One viewer tab per link, so page views on the same link take turns.
const queues = new Map(); // link -> Promise
function queued(link, fn) {
  const run = (queues.get(link) ?? Promise.resolve()).then(fn);
  queues.set(link, run.catch(() => {}));
  return run;
}

const screenshotPage = (link, n) => queued(link, async () => {
  const { pages } = await docInfo(link);
  const p = pages[n - 1];
  if (!p) throw new Error(`Page ${n} out of range, document has ${pages.length} pages`);
  const shoot = async () => { const page = await getTab(link); return page.screenshot({ clip: await goToPage(page, n), type: 'jpeg', quality: 85 }); };
  let jpg = await shoot();
  // The API says the page was edited but the viewer still shows the old pixels: it missed the sync, reload.
  const prev = seen.get(`${link} ${p.id}`);
  if (prev && p.lastModified > prev.lastModified && jpg.equals(prev.jpg)) {
    (await tabs.get(link)).close();
    tabs.delete(link);
    jpg = await shoot();
  }
  seen.set(`${link} ${p.id}`, { lastModified: p.lastModified, jpg });
  return { jpg, total: pages.length };
});

function makeServer() {
  const server = new McpServer({ name: 'goodnotes', version: '0.2.0' }, {
    instructions: 'Whenever the user shares a Goodnotes link (https://web.goodnotes.com/s/...), use these tools to look at it: '
      + 'call goodnotes_info, then view pages with goodnotes_page. The document is live: the user may keep writing on it during the chat. '
      + 'When they refer to something in it ("check this step", "what I just wrote"), call goodnotes_info to see which pages changed, '
      + 'then view those pages again rather than relying on an earlier screenshot.',
  });
  const linkArg = z.string().describe('Goodnotes share link, like https://web.goodnotes.com/s/abc123');
  const text = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 1) }] });

  server.registerTool('goodnotes_info', {
    description: 'Open a Goodnotes share link (kept open and syncing live). Returns the title and every page with its last edit time '
      + 'and whether it changed since you last viewed it. Use this to find the page the user is working on.',
    inputSchema: { link: linkArg },
  }, async ({ link }) => {
    getTab(link).catch(() => {}); // start loading the viewer now so the first page view is faster
    const { title, pages } = await docInfo(link);
    return text({
      title,
      pageCount: pages.length,
      pages: pages.map((p) => ({
        page: p.page,
        lastEdited: new Date(p.lastModified).toISOString(),
        changedSinceViewed: seen.has(`${link} ${p.id}`) ? p.lastModified > seen.get(`${link} ${p.id}`).lastModified : 'not viewed yet',
      })),
      now: new Date().toISOString(),
    });
  });

  server.registerTool('goodnotes_page', {
    description: 'See one page of a Goodnotes document exactly as it looks right now: an image of the page with handwriting, '
      + 'drawings, PDFs and images. Call it again to see new edits. Go through pages one call at a time to scroll the document.',
    inputSchema: { link: linkArg, page: z.number().int().min(1).describe('1-based page number') },
  }, async ({ link, page }) => {
    const { jpg, total } = await screenshotPage(link, page);
    return { content: [
      { type: 'text', text: `Page ${page} of ${total}` },
      { type: 'image', data: jpg.toString('base64'), mimeType: 'image/jpeg' },
    ] };
  });

  server.registerTool('goodnotes_wait_for_edit', {
    description: 'Wait until the user edits the Goodnotes document (for "watch while I write"), then return which pages changed. '
      + 'Times out after `seconds` with no change.',
    inputSchema: { link: linkArg, seconds: z.number().int().min(5).max(600).optional().describe('Max wait, default 50') },
  }, async ({ link, seconds = 50 }) => {
    const before = new Map((await docInfo(link)).pages.map((p) => [p.id, p.lastModified]));
    for (const end = Date.now() + seconds * 1000; Date.now() < end; await sleep(3000)) {
      const changed = (await docInfo(link)).pages.filter((p) => p.lastModified !== before.get(p.id));
      if (changed.length) {
        await sleep(5000); // let the stroke finish syncing to the viewer
        return text({ changedPages: changed.map((p) => p.page) });
      }
    }
    return text({ changedPages: [], note: `No edits in ${seconds} s` });
  });

  return server;
}

if (process.env.PORT) {
  // Remote mode (custom connector). MCP_TOKEN in the path keeps strangers off the server.
  const path = `/mcp${process.env.MCP_TOKEN ? `/${process.env.MCP_TOKEN}` : ''}`;
  http.createServer(async (req, res) => {
    if (req.url !== path) return res.writeHead(404).end();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => transport.close());
    await makeServer().connect(transport);
    await transport.handleRequest(req, res);
  }).listen(Number(process.env.PORT));
} else {
  await makeServer().connect(new StdioServerTransport());
}
