import TelegramBot from "node-telegram-bot-api";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolve } from "path";

// --- Config ---
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set");
  process.exit(1);
}

const ALLOWED_USERS = new Set(
  (process.env.TELEGRAM_ALLOWED_USERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
);

const HOME = process.env.HOME || "";
const CLAUDE_EXECUTABLE = process.env.CLAUDE_EXECUTABLE || resolve(HOME, ".local/bin/claude");
const SESSION_HOME = process.env.SESSION_HOME || process.cwd();

const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || `You are a developer assistant.
Your working directory is ${SESSION_HOME}.
You can read, modify, and run code in this project.
Respond in the user's language.

## Scope restriction
- You MUST only work within ${SESSION_HOME}. Do not access or modify files outside this directory.
- This bot manages and operates ${SESSION_HOME}. When code changes are needed, modify files in ${SESSION_HOME}. Do not modify ~/claude-boot.

## Running the bot
- When running bun run bot, load environment variables from ${SESSION_HOME}/.env

## Process management
- Use pm2 to manage long-running processes
- pm2 start "<command>" --name <name> --cwd ${SESSION_HOME}
- pm2 restart/stop/logs <name>

Be concise and direct. Execute tasks immediately without unnecessary confirmation.`;

// --- Session storage (in-memory, per user) ---
const sessions = new Map<number, string>();

// --- Bot ---
const bot = new TelegramBot(TOKEN, { polling: true, filepath: false });
console.log(`claude-boot started. cwd: ${SESSION_HOME}`);

// --- Active queries (per user abort control) ---
const activeQueries = new Map<number, { aborted: boolean }>();

// --- Polling error handler ---
bot.on("polling_error", async (err: any) => {
  const statusCode = err?.response?.statusCode;
  console.warn(`[polling_error] code=${err?.code} status=${statusCode} msg=${err?.message}`);

  if (statusCode === 429) {
    const retryAfter = (Number(err?.response?.body?.parameters?.retry_after) || 10) + 10;
    console.warn(`[polling] 429 rate limit — stopping polling, waiting ${retryAfter}s`);
    await bot.stopPolling();
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    console.info("[polling] resuming after rate limit wait");
    await bot.startPolling();
  }
  // 5xx 등 나머지는 라이브러리가 자동 재시도하므로 로그만
});

// --- Message handler (DM only) ---
bot.on("message", async (msg) => {
  if (msg.chat.type !== "private") return;

  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  if (!userId || !ALLOWED_USERS.has(userId)) {
    await bot.sendMessage(chatId, `Access denied. (id: ${userId})`);
    return;
  }

  const text = msg.text || msg.caption || "";
  if (!text) return;

  // /start
  if (text === "/start") {
    await bot.sendMessage(chatId, `claude-boot ready.\ncwd: ${SESSION_HOME}\n\nSend any message to interact with Claude.`);
    return;
  }

  // /reset — clear session
  if (text === "/reset") {
    sessions.delete(userId);
    await bot.sendMessage(chatId, "Session reset.");
    return;
  }

  // Abort previous query if running
  const running = activeQueries.get(userId);
  if (running) running.aborted = true;

  const control = { aborted: false };
  activeQueries.set(userId, control);

  // Typing indicator
  bot.sendChatAction(chatId, "typing").catch(() => {});
  const typingInterval = setInterval(() => {
    if (control.aborted) return clearInterval(typingInterval);
    bot.sendChatAction(chatId, "typing").catch(() => {});
  }, 4000);

  try {
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;

    const queryOptions: Record<string, unknown> = {
      pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
      cwd: SESSION_HOME,
      settingSources: ["project"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      env: cleanEnv,
      systemPrompt: SYSTEM_PROMPT,
    };

    const sessionId = sessions.get(userId);
    if (sessionId) {
      queryOptions.resume = sessionId;
    }

    let finalResponse = "";
    let newSessionId: string | null = null;
    let textBuffer = "";
    let toolStatusMsgId: number | null = null;
    let anySentText = false;
    let pendingToolName: string | null = null;
    let pendingToolInput = "";

    async function showToolStatus(label: string) {
      try {
        if (toolStatusMsgId) {
          await bot.editMessageText(label, { chat_id: chatId, message_id: toolStatusMsgId } as any);
        } else {
          const sent = await bot.sendMessage(chatId, label);
          toolStatusMsgId = sent.message_id;
        }
      } catch {}
    }

    async function clearToolStatus() {
      if (!toolStatusMsgId) return;
      const id = toolStatusMsgId;
      toolStatusMsgId = null;
      try { await bot.deleteMessage(chatId, id); } catch {}
    }

    async function flushText() {
      if (!textBuffer.trim()) return;
      const toSend = textBuffer.trim();
      textBuffer = "";
      await clearToolStatus();
      for (const chunk of splitMessage(toSend)) {
        await bot.sendMessage(chatId, chunk);
      }
      anySentText = true;
    }

    for await (const message of query({
      prompt: text,
      options: queryOptions as Parameters<typeof query>[0]["options"],
    })) {
      if (control.aborted) break;

      const msgType = (message as any).type;
      const msgSubtype = (message as any).subtype;

      // Capture session ID
      if (msgType === "system" && msgSubtype === "init") {
        newSessionId = (message as any).session_id;
        continue;
      }

      // Stream events (tool_use detection + text_delta)
      if (msgType === "stream_event") {
        const evt = (message as any).event;
        if (!evt) continue;

        if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
          pendingToolName = evt.content_block.name ?? null;
          pendingToolInput = "";
        }

        if (evt.type === "content_block_delta") {
          if (evt.delta?.type === "input_json_delta" && evt.delta?.partial_json) {
            pendingToolInput += evt.delta.partial_json;
          }
          if (evt.delta?.type === "text_delta" && evt.delta?.text) {
            textBuffer += evt.delta.text;
          }
        }

        if (evt.type === "content_block_stop" && pendingToolName) {
          let parsedInput: Record<string, unknown> = {};
          try { if (pendingToolInput) parsedInput = JSON.parse(pendingToolInput); } catch {}
          await flushText();
          await showToolStatus(`🔧 ${formatToolUse(pendingToolName, parsedInput)}`);
          pendingToolName = null;
          pendingToolInput = "";
        }
        continue;
      }

      // Tool use summary → permanent
      if (msgType === "tool_use_summary") {
        const summary = (message as any).summary as string;
        await clearToolStatus();
        for (const chunk of splitMessage(summary)) {
          await bot.sendMessage(chatId, chunk);
        }
        anySentText = true;
        continue;
      }

      // Final result
      if (msgType === "result") {
        finalResponse = (message as any).result || "";
        await clearToolStatus();
        continue;
      }
    }

    if (newSessionId) {
      sessions.set(userId, newSessionId);
    }

    if (!control.aborted) {
      await flushText();
      if (!anySentText) {
        if (finalResponse) {
          for (const chunk of splitMessage(finalResponse)) {
            await bot.sendMessage(chatId, chunk);
          }
        } else {
          await bot.sendMessage(chatId, "(no response)");
        }
      }
    }
  } catch (err) {
    if (!control.aborted) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      await bot.sendMessage(chatId, `Error: ${errMsg}`).catch(() => {});
    }
  } finally {
    clearInterval(typingInterval);
    activeQueries.delete(userId);
  }
});

// --- Cleanup ---
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  activeQueries.forEach((q) => (q.aborted = true));
  bot.stopPolling();
  process.exit(0);
});
process.on("SIGTERM", () => {
  activeQueries.forEach((q) => (q.aborted = true));
  bot.stopPolling();
  process.exit(0);
});

function formatToolUse(name: string, input: Record<string, unknown>): string {
  let detail = "";
  if (input.command) detail = String(input.command);
  else if (input.file_path || input.path) detail = String(input.file_path || input.path);
  else if (input.url) detail = String(input.url);
  else if (input.pattern) detail = String(input.pattern);
  else if (input.query || input.text) detail = String(input.query || input.text);
  else if (input.content) detail = String(input.content).slice(0, 80);
  if (detail) return `${name}(${detail.length > 100 ? detail.slice(0, 100) + "..." : detail})`;
  return name;
}

function splitMessage(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}
