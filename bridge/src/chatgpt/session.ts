import { chromium, type BrowserContext, type Page } from "playwright";
import type { BridgeConfig } from "../config.js";
import { findComposer } from "./page.js";

export class LoginRequiredError extends Error { code = "LOGIN_REQUIRED"; }

export class ChatGptSession {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  constructor(private readonly config: BridgeConfig) {}

  async start(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    this.context = await chromium.launchPersistentContext(this.config.CHATGPT_PROFILE_DIR, {
      headless: this.config.CHATGPT_HEADLESS,
      executablePath: this.config.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    });
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    await this.page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });
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

  async close() { await this.context?.close(); this.context = null; this.page = null; }
}
