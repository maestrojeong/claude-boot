const { resolve } = require("path");
const HOME = process.env.HOME || "";

module.exports = {
  apps: [
    {
      name: "claude-boot",
      script: "index.ts",
      interpreter: resolve(HOME, ".bun/bin/bun"),
      cwd: __dirname,
      env_file: ".env",
      env: {
        SESSION_HOME: resolve(HOME, "claudeCodeTelegram"),
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
};
