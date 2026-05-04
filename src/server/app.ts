/** Hono application for HTTP/SSE server. */

import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  health,
  createSessionHandler,
  getSessionHandler,
  listSessionsHandler,
  deleteSessionHandler,
  resumeSessionThreadHandler,
  listThreadsHandler,
  getThreadHandler,
  updateThreadHandler,
  createThreadHandler,
  forkThreadHandler,
  threadEventsHandler,
  threadItemsHandler,
  interruptTurnHandler,
  listToolsHandler,
  listSkillsHandler,
  chatHandler,
} from "./handlers.js";

export function createApp(): Hono {
  const app = new Hono();
  app.use("/*", cors());

  app.get("/v1/health", health);
  app.post("/v1/session", createSessionHandler);
  app.get("/v1/session/:session_id", getSessionHandler);
  app.get("/v1/sessions", listSessionsHandler);
  app.get("/v1/sessions/:session_id", getSessionHandler);
  app.delete("/v1/sessions/:session_id", deleteSessionHandler);
  app.post("/v1/sessions/:session_id/resume-thread", resumeSessionThreadHandler);
  app.get("/v1/threads", listThreadsHandler);
  app.post("/v1/threads", createThreadHandler);
  app.get("/v1/threads/:thread_id", getThreadHandler);
  app.patch("/v1/threads/:thread_id", updateThreadHandler);
  app.post("/v1/threads/:thread_id/fork", forkThreadHandler);
  app.get("/v1/threads/:thread_id/events", threadEventsHandler);
  app.get("/v1/threads/:thread_id/items", threadItemsHandler);
  app.post("/v1/threads/:thread_id/turns/:turn_id/interrupt", interruptTurnHandler);
  app.get("/v1/tools", listToolsHandler);
  app.get("/v1/skills", listSkillsHandler);
  app.post("/v1/session/:session_id/chat", chatHandler);

  return app;
}

export function runServer(host = "0.0.0.0", port = 8080): void {
  const app = createApp();
  console.log(`Seek Code server starting on ${host}:${port}...`);
  // Use @hono/node-server for Node.js
  import("@hono/node-server").then(({ serve }) => {
    serve({ fetch: app.fetch, hostname: host, port });
    console.log(`Server running at http://${host}:${port}`);
    console.log(`Health check: http://${host}:${port}/v1/health`);
  });
}
