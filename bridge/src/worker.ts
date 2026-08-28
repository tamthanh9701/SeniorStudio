import type { BridgeConfig } from "./config.js";
import { BridgePageError, bindConversation, extractAssistantText, extractImage, saveDiagnostics, submitPrompt, waitForResult } from "./chatgpt/page.js";
import { ChatGptSession, LoginRequiredError } from "./chatgpt/session.js";
import { BridgeStore, type BrowserJob } from "./supabase.js";
export type WorkerSnapshot = { state: string; activeJobId: string | null; currentUrl: string | null; errorCode: string | null; diagnostics: { screenshot: string; dom: string } | null };

const sleep = (milliseconds: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
};

export class BrowserBridgeWorker {
  readonly snapshot: WorkerSnapshot = { state: "starting", activeJobId: null, currentUrl: null, errorCode: null, diagnostics: null };
  private readonly store: BridgeStore; private readonly session: ChatGptSession; private stopped = false;
  constructor(private readonly config: BridgeConfig) { this.store = new BridgeStore(config); this.session = new ChatGptSession(config); }

  stop() { this.stopped = true; }
  async run() {
    const heartbeat = setInterval(() => void this.store.heartbeat(this.snapshot.state === "needs_login" ? "needs_login" : this.snapshot.errorCode ? "degraded" : "online", this.snapshot.activeJobId, this.snapshot.errorCode).catch(console.error), 10_000);
    try {
      while (!this.stopped) {
        await this.store.heartbeat("online", this.snapshot.activeJobId);
        const job = await this.store.claim();
        if (!job) {
          this.snapshot.state = "idle";
          await this.session.start().then((page) => { this.snapshot.currentUrl = page.url(); }).catch((error) => {
            this.snapshot.errorCode = error instanceof Error ? error.message : "BROWSER_START_FAILED";
          });
          await sleep(this.config.CHATGPT_POLL_INTERVAL_MS);
          continue;
        }
        await this.process(job);
      }
    } finally { clearInterval(heartbeat); await this.session.close(); }
  }

  private async process(job: BrowserJob) {
    this.snapshot.activeJobId = job.id; this.snapshot.state = "claimed"; this.snapshot.errorCode = null; this.snapshot.diagnostics = null;
    let submitted = false;
    const renew = setInterval(() => void this.store.renew(job.id).catch(() => { this.stopped = true; }), 30_000);
    try {
      const page = await this.session.readyPage(); this.snapshot.currentUrl = page.url();
      await bindConversation(page, job.provider_conversation_url); this.snapshot.currentUrl = page.url();
      const attachment = job.operation === "edit" && job.parent_version_id ? await this.store.downloadParent(job.parent_version_id) : undefined;
      await this.store.state(job.id, "submitting", page.url()); this.snapshot.state = "submitting";
      const dispatch = await submitPrompt(page, job.operation, job.prompt, attachment); submitted = true;
      await this.store.state(job.id, "generating", dispatch.conversationUrl); this.snapshot.state = "generating"; this.snapshot.currentUrl = dispatch.conversationUrl;
      const turn = await waitForResult(page, dispatch.assistantCountBefore, this.config.CHATGPT_JOB_TIMEOUT_SECONDS);
      const text = await extractAssistantText(turn);
      if (job.operation === "chat") await this.store.completeChat(job.id, text, page.url());
      else {
        await this.store.state(job.id, "downloading", page.url()); this.snapshot.state = "downloading";
        const image = await extractImage(page, turn);
        await this.store.state(job.id, "persisting", page.url()); this.snapshot.state = "persisting";
        await this.store.completeImage(job, image.bytes, text, page.url(), { extraction_method: image.method });
      }
      this.snapshot.state = "idle";
    } catch (error) {
      const page = await this.session.start().catch(() => null);
      const code = error instanceof LoginRequiredError ? error.code : error instanceof BridgePageError ? error.code : submitted ? "WORKER_ERROR_AFTER_SUBMISSION" : "WORKER_ERROR";
      const status = error instanceof LoginRequiredError ? "needs_login" : submitted || (error instanceof BridgePageError && error.review) ? "needs_review" : "failed";
      this.snapshot.state = status; this.snapshot.errorCode = code;
      if (page && (code === "CHATGPT_UI_CHANGED" || status === "needs_review")) this.snapshot.diagnostics = await saveDiagnostics(page, this.config.CHATGPT_DIAGNOSTICS_DIR, job.id).catch(() => null);
      await this.store.fail(job.id, status, code, error instanceof Error ? error.message : String(error));
    } finally {
      clearInterval(renew); this.snapshot.activeJobId = null;
    }
  }
}
