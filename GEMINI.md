# GEMINI.md - doctorville-auto

## Project Overview

This project is a Node.js-based automation tool for a website called "Doctorville". It uses Playwright for web browser automation and is designed to run scheduled tasks (using `node-cron`) and be controlled via a Telegram bot (using `telegraf`).

The primary purpose of this tool is to automate daily routines on the Doctorville website, such as checking attendance, applying for seminars, and taking quizzes. It also monitors for new seminars and sends notifications and on-demand information to Telegram channels.

**Core Technologies:**
*   **Node.js:** The runtime environment.
*   **Playwright:** Used for web browser automation to interact with the Doctorville website.
*   **node-cron:** Used for scheduling recurring tasks.
*   **Telegraf:** Used to create and manage the Telegram bot for remote control and notifications.
*   **dotenv:** Used for managing environment variables.

**Architecture:**
*   `main.js`: The main entry point of the application. It initializes the scheduler, registers tasks, and starts the Telegram bot.
*   `scheduler.js`: Manages the cron-style scheduled jobs.
*   `taskRegistry.js`: Holds a registry of all available tasks that can be run either on a schedule or on-demand.
*   `runner.js`: Responsible for executing the individual tasks.
*   `telegram.js`: Implements the Telegram bot, defining commands and handling user interactions.
*   `tasks/`: This directory contains the individual automation scripts for specific actions on the website (e.g., `login.js`, `attendance.js`).
*   `modules/`: Contains shared utility modules, such as `utils.js`.
*   `.env.example`: An example file for the required environment variables.

## Building and Running

### Prerequisites
*   Node.js
*   npm

### Installation
1.  Clone the repository.
2.  Install the dependencies:
    ```bash
    npm install
    ```
3.  Install Playwright's browsers:
    ```bash
    npx playwright install
    ```

### Configuration
1.  Create a `.env` file by copying the `.env.example` file:
    ```bash
    cp .env.example .env
    ```
2.  Edit the `.env` file and provide the necessary values for:
    *   `DV_USER`: Your Doctorville username.
    *   `DV_PASS`: Your Doctorville password.
    *   `TELEGRAM_BOT_TOKEN`: Your admin Telegram bot token.
    *   `TELEGRAM_CHAT_ID`: The chat ID for admin notifications.
    *   `NOTICE_BOT_TOKEN`: Your notice Telegram bot token.
    *   `NOTICE_CHANNEL_ID`: The chat ID for public notifications.
    *   Other optional variables like `HEADLESS`, `DAILY_CRON`, `SCHEDULE_TZ`.

### Running the Application
To run the application in the foreground:
```bash
node main.js
```

### Running as a Service (Systemd)
The project includes a `doctorville-auto.service` file in the `deploy/` directory, suggesting it's intended to run as a systemd service on Linux.

To set it up:
1.  Copy the service file:
    ```bash
    sudo cp deploy/doctorville-auto.service /etc/systemd/system/
    ```
2.  Reload the systemd daemon:
    ```bash
    sudo systemctl daemon-reload
    ```
3.  Start the service:
    ```bash
    sudo systemctl start doctorville-auto.service
    ```
4.  Enable the service to start on boot:
    ```bash
    sudo systemctl enable doctorville-auto.service
    ```

The `package.json` also includes an `update` script to automate pulling the latest code and restarting the service:
```bash
npm run update
```

## Development Conventions

*   **Task-based Architecture:** New automation routines should be created as separate files within the `tasks/` directory. Each task file should export a `run` function.
*   **Task Registration:** Tasks that need to be run on a schedule or via Telegram must be registered in `main.js` using `scheduler.scheduleTaskCron()` for scheduled tasks and `taskRegistry.registerTask()` for on-demand tasks.
*   **Environment Variables:** All configuration and secrets should be managed through the `.env` file. Do not hardcode credentials.
*   **Telegram Commands:** When adding new functionality that should be user-triggered, add a new command in `telegram.js`. Remember to also add it to the `/help` command's message.
*   **Logging:** Use the provided `logger` module for logging application events and errors.
*   **Error Handling:** Tasks should implement robust error handling. The main `daily_routine` task in `main.js` shows an example of looping through sub-tasks and sending a Telegram notification on failure.
*   **Debugging:** The `/inspect <url> <selector>` Telegram command is a powerful tool for interactively debugging website selectors and layouts.
