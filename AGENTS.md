# Repository Guidelines

**always respond with 한국어**

## Project Structure & Module Organization
- Runtime orchestration lives in `main.js`, `scheduler.js`, `runner.js`, and `taskRegistry.js`; they schedule cron jobs and expose tasks to Telegram triggers.
- Automation steps sit in `tasks/` (e.g., `attendance.js`, `today_quiz.js`, `monitor_seminars.js`), each exporting `run({ page, context })` for Playwright.
- Shared helpers are in `modules/` (`utils.js`, `inspect.js`); common services at the root (`logger.js`, `telegram.js`, `storage.js`).
- Persistent/sample data is under `data/` (`state.json`, `quiz.json`); screenshots land in `screenshot/`. Deployment config is in `deploy/doctorville-auto.service`. CI cron is `.github/workflows/cron.yml`.

## Build, Test, and Development Commands
- Install deps: `npm install`, then `npx playwright install` for browser binaries.
- Lint: `npm run lint` (ESLint + Prettier). Auto-fix: `npm run lint:fix`.
- Host service control: `npm run restart` to reload the `doctorville-auto` systemd unit; `npm run update` pulls main, installs the unit, and restarts. Use only on the target host with proper privileges.
- There is no automated test suite (`npm test` exits intentionally).

## Coding Style & Naming Conventions
- JavaScript (CommonJS). ESLint config in `eslint.config.js` with Prettier; formatting is 2 spaces, width 120, single quotes, trailing commas.
- Remove unused vars or prefix with `_` to satisfy lint rules; `no-prototype-builtins` is intentionally off.
- Task files use snake_case to match registry names; register new tasks in `taskRegistry.js` when they need scheduling or Telegram exposure.

## Testing Guidelines
- No unit tests yet; favor lightweight Playwright verification in headless mode and log assertions via `logger.js`.
- If you add tests, colocate them near features (e.g., `tasks/__tests__/foo.test.js`) and wire `npm test` accordingly.
- For manual checks, run individual tasks via `runner.js` or import the task and call `run()` with a Playwright context.

## Environment, Security & Configuration Tips
- Required env vars: `DV_USER`, `DV_PASS`. Optional: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `HEADLESS`, `DAILY_CRON`, `SCHEDULE_TZ`. Copy `.env.example` to `.env`; never commit secrets.
- Playwright runs with `--no-sandbox`; deploy only on trusted hosts. Avoid committing real cookies (`cookies.json`, `localstorage.json`) or personal data in `data/`.
- GitHub Actions cron defaults to daily 08:01 Asia/Seoul; adjust `.github/workflows/cron.yml` or `DAILY_CRON` as needed.

## Commit & Pull Request Guidelines
- Follow existing history: `feat: ...`, `fix: ...`, `chore: ...`, `update ...`; use imperative phrasing.
- Pull requests should list purpose, key changes, new env vars, manual test commands/results, and screenshots/log snippets for UI-visible behavior.
- Reference related issues and mention deployment steps (e.g., rerun `npm run update` or rotate secrets) when relevant.
