#!/usr/bin/env node
// MCP server: view a Goodnotes share link live. Keeps one headless Chromium tab per link open,
// so the Goodnotes web app keeps syncing in the background, and screenshots pages on demand.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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

async function indicator(page) {
  const [cur, total] = (await page.textContent('#pageIndicator')).match(/\d+/g).map(Number);
  return { cur, total };
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

const server = new McpServer({ name: 'goodnotes', version: '0.1.0' });
const linkArg = z.string().describe('Goodnotes share link, like https://web.goodnotes.com/s/abc123');

server.registerTool('goodnotes_info', {
  description: 'Open a Goodnotes share link (kept open and syncing live) and return its title and page count.',
  inputSchema: { link: linkArg },
}, async ({ link }) => {
  const page = await getTab(link);
  const { cur, total } = await indicator(page);
  const title = await page.evaluate(() => document.querySelector('header, [class*="toolbar"]')?.innerText.split('\n')[0] ?? '');
  return { content: [{ type: 'text', text: JSON.stringify({ title, pages: total, currentPage: cur }) }] };
});

server.registerTool('goodnotes_page', {
  description: 'Screenshot one page of a Goodnotes share link as it looks right now, including handwriting. '
    + 'The link stays open and syncs live, so call again to see new edits (sync lag is a few seconds).',
  inputSchema: {
    link: linkArg,
    page: z.number().int().min(1).describe('1-based page number'),
    reload: z.boolean().optional().describe('Reload the link first, if edits are not showing up'),
  },
}, async ({ link, page: n, reload }) => {
  let page = await getTab(link);
  if (reload) {
    await page.close();
    tabs.delete(link);
    page = await getTab(link);
  }
  const { total } = await indicator(page);
  if (n > total) throw new Error(`Page ${n} out of range, document has ${total} pages`);
  const clip = await goToPage(page, n);
  const jpg = await page.screenshot({ clip, type: 'jpeg', quality: 85 });
  return { content: [
    { type: 'text', text: `Page ${n} of ${total}` },
    { type: 'image', data: jpg.toString('base64'), mimeType: 'image/jpeg' },
  ] };
});

await server.connect(new StdioServerTransport());
