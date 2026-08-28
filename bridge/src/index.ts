import http from "node:http";
import { loadConfig } from "./config.js";
import { BrowserBridgeWorker } from "./worker.js";

const config = loadConfig();
const worker = new BrowserBridgeWorker(config);
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/healthz") {
    response.end(JSON.stringify({ status: worker.snapshot.state, worker_id: config.BRIDGE_WORKER_ID, active_job_id: worker.snapshot.activeJobId }));
    return;
  }
  if (request.url === "/diagnostics/latest") {
    response.end(JSON.stringify({ current_url: worker.snapshot.currentUrl, last_state: worker.snapshot.state, last_error_code: worker.snapshot.errorCode, artifacts: worker.snapshot.diagnostics }));
    return;
  }
  response.statusCode = 404; response.end(JSON.stringify({ error: "NOT_FOUND" }));
});
server.listen(config.BRIDGE_ADMIN_PORT, "0.0.0.0");

const shutdown = () => { worker.stop(); server.close(); };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
await worker.run();
