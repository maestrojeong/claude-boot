# Claude Boot

## Running the bot
- When running bun run bot, always use ~/claudeCodeTelegram as the working directory and load environment variables from ~/claudeCodeTelegram/.env

## Process management
- Use pm2 to manage long-running processes
- pm2 start "<command>" --name <name> --cwd ~/claude-boot
- pm2 restart/stop/logs <name>

## claudeCodeTelegram pm2 실행 시 주의사항

### .env 우선순위 문제
- bun은 쉘 환경변수가 이미 존재하면 `.env` 파일 값을 **덮어쓰지 않음**
- 이 맥미니에 `TELEGRAM_ALLOWED_USERS`, `TELEGRAM_BOT_TOKEN` 등이 쉘 환경에 남아있을 수 있음
- pm2는 실행 시 현재 쉘 환경변수를 그대로 상속하므로, `.env` 파일이 무시될 수 있음

### 올바른 pm2 실행 방법
```bash
# 쉘 환경변수를 제거하고 실행해야 .env 파일이 정상 로드됨
pm2 start "env -u TELEGRAM_ALLOWED_USERS -u TELEGRAM_BOT_TOKEN bun run bot" \
  --name claudeCodeTelegram \
  --cwd ~/claudeCodeTelegram
```

### 주의
- 같은 봇 토큰으로 2개 이상 인스턴스 실행 시 `ETELEGRAM status:409 polling_error` 발생
- pm2 delete 후 start 할 때 중복 생성되지 않도록 주의
