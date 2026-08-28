import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";

export class BridgePageError extends Error {
  constructor(public code: string, message: string, public review = true) { super(message); }
}

export async function findComposer(page: Page, timeout = 0): Promise<Locator | null> {
  const candidates = [page.locator("#prompt-textarea"), page.locator(".ProseMirror[contenteditable='true']"), page.getByRole("textbox").filter({ visible: true })];
  const deadline = Date.now() + timeout;
  do {
    for (const candidate of candidates) if (await candidate.first().isVisible().catch(() => false)) return candidate.first();
    if (Date.now() < deadline) await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  return null;
}

async function composerSendButton(composer: Locator): Promise<Locator | null> {
  const scope = composer.locator("xpath=ancestor::*[self::form or @data-testid='composer' or contains(@class,'composer')][1]");
  const selectors = ["#composer-submit-button", "[data-testid*='send']", "button[aria-label*='Send' i]"];
  for (const selector of selectors) {
    const button = scope.locator(selector).first();
    if (await button.isVisible().catch(() => false)) {
      const label = `${await button.getAttribute("aria-label") ?? ""} ${await button.textContent() ?? ""}`;
      if (!/stop|cancel/i.test(label)) return button;
    }
  }
  return null;
}

function assistantTurns(page: Page) {
  return page.locator("[data-message-author-role='assistant'], article:has([data-message-author-role='assistant'])");
}

async function stopVisible(page: Page) {
  return page.getByRole("button", { name: /stop|cancel generation/i }).first().isVisible().catch(() => false);
}

export function wrappedPrompt(operation: "chat" | "generate" | "edit", message: string): string {
  if (operation === "chat") return `${message}\n\nAnswer in text.`;
  if (operation === "generate") return `Use ChatGPT's built-in image generation capability to create exactly one image. User request: ${message}. After generation, provide a short one-sentence caption.`;
  return `Edit the attached source image. User request: ${message}. Create exactly one edited image and provide a short one-sentence caption.`;
}

async function attachFile(page: Page, bytes: Buffer, filename: string, mimeType: string) {
  const input = page.locator("input[type=file]").first();
  if (!await input.count()) throw new BridgePageError("CHATGPT_UI_CHANGED", "No ChatGPT file input found");
  await input.setInputFiles({ name: filename, mimeType, buffer: bytes });
}

export async function bindConversation(page: Page, conversationUrl: string | null) {
  if (!conversationUrl) { await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" }); return; }
  await page.goto(conversationUrl, { waitUntil: "domcontentloaded" });
  const expected = new URL(conversationUrl); const actual = new URL(page.url());
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) throw new BridgePageError("BOUND_CONVERSATION_UNAVAILABLE", "Saved ChatGPT conversation could not be opened");
}

export async function submitPrompt(page: Page, operation: "chat" | "generate" | "edit", message: string, attachment?: { bytes: Buffer; filename: string; mimeType: string }) {
  const before = await assistantTurns(page).count();
  const composer = await findComposer(page, 10_000);
  if (!composer) throw new BridgePageError("CHATGPT_UI_CHANGED", "Prompt composer not found");
  if (attachment) await attachFile(page, attachment.bytes, attachment.filename, attachment.mimeType);
  await composer.fill(wrappedPrompt(operation, message));
  const send = await composerSendButton(composer);
  if (!send) throw new BridgePageError("CHATGPT_UI_CHANGED", "Send button not found");
  await send.click();
  const submitted = await Promise.race([
    page.waitForFunction((text) => document.body.innerText.includes(text as string), message.slice(0, 120), { timeout: 5000 }).then(() => true).catch(() => false),
    page.getByRole("button", { name: /stop|cancel generation/i }).first().waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false),
  ]);
  if (!submitted) throw new BridgePageError("SUBMISSION_AMBIGUOUS", "Could not prove the prompt was submitted");
  await page.waitForURL(/https:\/\/chatgpt\.com\/c\/[^/]+/, { timeout: 30000 }).catch(() => undefined);
  return { assistantCountBefore: before, conversationUrl: page.url() };
}

export async function waitForResult(page: Page, previousCount: number, timeoutSeconds: number): Promise<Locator> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let previous = ""; let stable = 0;
  while (Date.now() < deadline) {
    const turns = assistantTurns(page); const count = await turns.count();
    if (count > previousCount && !await stopVisible(page)) {
      const current = (await turns.nth(count - 1).innerText().catch(() => "")).trim();
      stable = current && current === previous ? stable + 1 : 0; previous = current;
      if (stable >= 2) return turns.nth(count - 1);
    }
    await page.waitForTimeout(1000);
  }
  throw new BridgePageError("GENERATION_TIMEOUT", "ChatGPT response timed out", false);
}

export async function extractAssistantText(turn: Locator): Promise<string> {
  const text = await turn.innerText();
  return text.split("\n").filter((line) => !/^(copy|download|share|good response|bad response)$/i.test(line.trim())).join("\n").trim().slice(0, 32768);
}

export async function extractImage(page: Page, turn: Locator): Promise<{ bytes: Buffer; method: string }> {
  const images = turn.locator("img"); const candidates: Locator[] = [];
  for (let index = 0; index < await images.count(); index++) {
    const image = images.nth(index);
    const size = await image.evaluate((element) => ({ width: (element as HTMLImageElement).naturalWidth, height: (element as HTMLImageElement).naturalHeight }));
    if (size.width >= 256 && size.height >= 256) candidates.push(image);
  }
  if (candidates.length === 0) throw new BridgePageError("IMAGE_NOT_FOUND", "No generated image found", false);
  if (candidates.length > 1) throw new BridgePageError("MULTIPLE_IMAGES", "Multiple generated images require manual review");
  const candidate = candidates[0];
  const scopedDownload = turn.getByRole("button", { name: /download/i }).first();
  if (await scopedDownload.isVisible().catch(() => false)) {
    const download = await Promise.all([page.waitForEvent("download"), scopedDownload.click()]).then(([value]) => value).catch(() => null);
    if (download) return { bytes: await requireDownloadBytes(download.createReadStream()), method: "download_button" };
  }
  const source = await candidate.getAttribute("src");
  if (source) {
    const response = await page.context().request.get(source);
    if (response.ok()) return { bytes: Buffer.from(await response.body()), method: "context_request" };
  }
  const natural = await candidate.evaluate((element) => ({ width: (element as HTMLImageElement).naturalWidth, height: (element as HTMLImageElement).naturalHeight, renderedWidth: element.getBoundingClientRect().width }));
  if (natural.width >= 256 && natural.height >= 256 && natural.renderedWidth >= 256) return { bytes: await candidate.screenshot({ type: "png" }), method: "element_screenshot" };
  throw new BridgePageError("CHATGPT_UI_CHANGED", "Generated image could not be downloaded");
}

async function requireDownloadBytes(streamPromise: Promise<NodeJS.ReadableStream | null>) {
  const stream = await streamPromise; if (!stream) throw new Error("Download stream unavailable");
  const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks);
}

export async function saveDiagnostics(page: Page, directory: string, jobId: string, turn?: Locator): Promise<{ screenshot: string; dom: string }> {
  const target = path.join(directory, jobId); await mkdir(target, { recursive: true });
  const screenshot = path.join(target, "page.png"); const dom = path.join(target, "turn.html");
  await page.screenshot({ path: screenshot, fullPage: true });
  const html = (turn ? await turn.evaluate((element) => element.outerHTML) : await page.locator("body").evaluate((element) => element.outerHTML))
    .replace(/value="[^"]*"/gi, "value=\"[redacted]\"").slice(0, 200000);
  await writeFile(dom, html, "utf8"); return { screenshot, dom };
}
