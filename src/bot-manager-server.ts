#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";

const ENV_PATH = "/Users/maestrobot/claudeCodeTelegram/.env";
const BOT_CWD = "/Users/maestrobot/claudeCodeTelegram";

function readEnv(): Record<string, string> {
  const content = readFileSync(ENV_PATH, "utf-8");
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx);
    const val = trimmed.slice(idx + 1).replace(/^"(.*)"$/, "$1");
    result[key] = val;
  }
  return result;
}

function writeEnv(env: Record<string, string>) {
  const lines = readFileSync(ENV_PATH, "utf-8").split("\n");
  const result: string[] = [];
  const written = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      result.push(line);
      continue;
    }
    const idx = trimmed.indexOf("=");
    if (idx === -1) { result.push(line); continue; }
    const key = trimmed.slice(0, idx);
    if (key in env) {
      result.push(`${key}="${env[key]}"`);
      written.add(key);
    } else {
      result.push(line);
    }
  }
  writeFileSync(ENV_PATH, result.join("\n"));
}

function getAllowedUsers(): string[] {
  const env = readEnv();
  return (env["TELEGRAM_ALLOWED_USERS"] || "").split(",").map(s => s.trim()).filter(Boolean);
}

function setAllowedUsers(users: string[]) {
  const env = readEnv();
  env["TELEGRAM_ALLOWED_USERS"] = users.join(",");
  writeEnv(env);
}

function restartBot() {
  try {
    execSync("pm2 delete claudeCodeTelegram", { stdio: "pipe" });
  } catch {}
  execSync(
    `pm2 start "env -u TELEGRAM_ALLOWED_USERS -u TELEGRAM_BOT_TOKEN bun run bot" --name claudeCodeTelegram --cwd ${BOT_CWD}`,
    { stdio: "pipe" }
  );
}

const server = new McpServer({ name: "bot-manager", version: "1.0.0" });

server.tool(
  "list_users",
  "List all allowed Telegram user IDs for claudeCodeTelegram",
  {},
  async () => {
    const users = getAllowedUsers();
    return {
      content: [{ type: "text" as const, text: users.length > 0 ? users.join("\n") : "(empty)" }],
    };
  }
);

server.tool(
  "add_user",
  "Add a Telegram user ID to the allowed users list and restart the bot",
  { user_id: z.string().describe("Telegram user ID to add") },
  async ({ user_id }) => {
    const users = getAllowedUsers();
    if (users.includes(user_id)) {
      return { content: [{ type: "text" as const, text: `Already exists: ${user_id}` }] };
    }
    users.push(user_id);
    setAllowedUsers(users);
    restartBot();
    return { content: [{ type: "text" as const, text: `Added ${user_id} and restarted bot. Total: ${users.length} users` }] };
  }
);

server.tool(
  "remove_user",
  "Remove a Telegram user ID from the allowed users list and restart the bot",
  { user_id: z.string().describe("Telegram user ID to remove") },
  async ({ user_id }) => {
    const users = getAllowedUsers();
    if (!users.includes(user_id)) {
      return { content: [{ type: "text" as const, text: `Not found: ${user_id}` }] };
    }
    const updated = users.filter(u => u !== user_id);
    setAllowedUsers(updated);
    restartBot();
    return { content: [{ type: "text" as const, text: `Removed ${user_id} and restarted bot. Total: ${updated.length} users` }] };
  }
);

server.tool(
  "restart_bot",
  "Restart claudeCodeTelegram safely (env -u method to ensure .env is loaded correctly)",
  {},
  async () => {
    restartBot();
    return { content: [{ type: "text" as const, text: "Bot restarted successfully" }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
