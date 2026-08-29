import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { BridgeConfig } from "../config.js";
import { findComposer } from "./page.js";

export class LoginRequiredError extends Error { code = "LOGIN_REQUIRED"; }

export class ChatGptSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  constructor(private readonly config: BridgeConfig) {}


  async start(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    await this.browser?.close().catch(() => undefined);
    this.browser = await chromium.connectOverCDP(this.config.CHATGPT_CDP_URL);
    this.context = this.browser.contexts()[0];
    if (!this.context) throw new Error("Desktop Chromium did not expose a browser context");
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    if (this.page.url() === "about:blank") await this.page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });
    return this.page;
  }

  async readyPage(): Promise<Page> {
    const page = await this.start();
    const signIn = page.getByRole("button", { name: /log in|sign in|continue/i }).or(page.getByRole("link", { name: /log in|sign in/i }));
    if (await signIn.first().isVisible().catch(() => false) || /challenge|auth/.test(page.url())) {
      throw new LoginRequiredError("Manual ChatGPT login required");
    }
    if (!await findComposer(page, 10_000)) throw new Error("CHATGPT_UI_CHANGED");
    return page;
  }

  async close() { await this.browser?.close(); this.browser = null; this.context = null; this.page = null; }
}
