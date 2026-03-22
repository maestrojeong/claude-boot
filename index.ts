import TelegramBot from "node-telegram-bot-api";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolve } from "path";
import { readFileSync, existsSync } from "fs";

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

const HOME = process.env.HOME || "/Users/maestrobot";
const CLAUDE_EXECUTABLE = resolve(HOME, ".local/bin/claude");
const SESSION_HOME = resolve(HOME, "claudeCodeTelegram");

const SYSTEM_PROMPT = `You are a developer assistant for the claudeCodeTelegram project.
Your working directory is ${SESSION_HOME}.
You can read, modify, and run code in this project.
Respond in the user's language (default: Korean).

Key commands:
- bun run bot — run the telegram bot
- bun run dev — run the next.js dev server
- bun install — install dependencies

Be concise and direct. Execute tasks immediately without unnecessary confirmation.`;

// --- Session storage (in-memory, per user) ---
const sessions = new Map<number, string>();

// --- Bot ---
const bot = new TelegramBot(TOKEN, { polling: true, filepath: false });
console.log(`claude-boot started. cwd: ${SESSION_HOME}`);

// --- Active queries (per user abort control) ---
const activeQueries = new Map<number, { aborted: boolean }>();

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

    for await (const message of query({
      prompt: text,
      options: queryOptions as Parameters<typeof query>[0]["options"],
    })) {
      if (control.aborted) break;

      const msgType = "type" in message ? (message as any).type : undefined;
      const msgSubtype = "subtype" in message ? (message as any).subtype : undefined;

      // Capture session ID
      if (msgType === "system" && msgSubtype === "init") {
        newSessionId = (message as any).session_id;
      }

      // Capture result
      if ("result" in message) {
        finalResponse = (message as any).result || "";
      }
    }

    if (newSessionId) {
      sessions.set(userId, newSessionId);
    }

    if (finalResponse && !control.aborted) {
      for (const chunk of splitMessage(finalResponse)) {
        await bot.sendMessage(chatId, chunk);
      }
    } else if (!control.aborted) {
      await bot.sendMessage(chatId, "(no response)");
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
