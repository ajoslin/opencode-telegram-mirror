# OpenCode Telegram Mirror

A standalone bot that mirrors OpenCode sessions to Telegram topics, enabling collaborative AI-assisted coding conversations in Telegram.

## Installation

```bash
npm install -g opencode-telegram-mirror
```

## Quick Start

1. **Create a Telegram Bot**:
   - Message [@BotFather](https://t.me/BotFather) on Telegram
   - Send `/newbot` and follow instructions
   - Copy your bot token

2. **Get your Chat ID**:
   - Message [@userinfobot](https://t.me/userinfobot)
   - Copy your chat ID

3. **Run the mirror**:
   ```bash
   opencode-telegram-mirror
   ```

4. **Configure environment variables**:
   ```bash
   export TELEGRAM_BOT_TOKEN="your-bot-token"
   export TELEGRAM_CHAT_ID="your-chat-id"
   # Optional: export TELEGRAM_THREAD_ID="your-thread-id"
   ```

That's it! Your OpenCode sessions will now be mirrored to Telegram.

## How it works

The Telegram mirror streams OpenCode session interactions (questions, answers, tool usage, and file edits) to Telegram topics. This enables:

- **Collaborative coding**: Share your coding sessions with team members
- **Remote pair programming**: Get real-time feedback on your code
- **Session persistence**: Keep conversations going across devices
- **Rich formatting**: Code blocks, diffs, and interactive buttons

### Architecture

Each instance of the `opencode-telegram-mirror` binary mirrors **one OpenCode session** to **one Telegram channel/thread**. This 1:1 mapping ensures clean separation between different coding conversations.

**OpenCode Server Connection**:
- **Without `OPENCODE_URL`**: The mirror spawns its own OpenCode server instance locally
- **With `OPENCODE_URL`**: The mirror connects to an existing OpenCode server at the specified URL

This flexibility allows you to either run self-contained mirrors (each with their own server) or connect to a shared/managed OpenCode server.

### Threading & Topics

Telegram supports threaded conversations in forum-style channels:

- **No thread ID**: Messages go to the main channel
- **With thread ID**: Messages go to a specific topic thread within a forum channel

Each mirror instance should be configured with a unique `TELEGRAM_THREAD_ID` to prevent cross-contamination between different coding sessions.

### Orchestration

While you can run a single mirror instance, production deployments typically require orchestration to support multiple concurrent sessions:

- **Multiple sessions**: Run separate mirror processes for different coding projects
- **Thread isolation**: Use unique thread IDs per session
- **Server sharing**: Point multiple mirrors to the same `OPENCODE_URL` for resource efficiency
- **Load balancing**: Distribute mirrors across multiple servers

Example orchestration might involve:
- Docker containers for each mirror instance
- Kubernetes deployments with unique environment configs
- Process managers like PM2 for local deployment

### Updates URL & Multi-Instance Deployments

**Single Instance (Simple Case)**:
If you're running one `opencode-telegram-mirror` instance with one Telegram bot and one channel, you don't need `TELEGRAM_UPDATES_URL`. The mirror will poll Telegram's API directly using `getUpdates`.

**Multi-Instance Deployments**:
When running multiple mirror instances (e.g., one per coding session or per team), Telegram only allows one webhook or one `getUpdates` poller per bot. To support multiple mirrors:

1. **Central Updates Collector**: Deploy a central service that polls `getUpdates` once and distributes updates to multiple mirrors
2. **Set `TELEGRAM_UPDATES_URL`**: Point each mirror to this central endpoint
3. **Thread Isolation**: Each mirror should have a unique `TELEGRAM_THREAD_ID`

**Updates URL API Contract**:
The central updates endpoint must accept GET requests with query parameters:
- `since`: Last processed `update_id` (for pagination)
- `chat_id`: Filter updates to specific chat
- `thread_id`: Filter to specific thread (optional)

Response format (JSON):
```json
{
  "updates": [
    {
      "payload": {
        "update_id": 123,
        "message": {
          "message_id": 456,
          "message_thread_id": 789,
          "date": 1640995200,
          "text": "Hello world",
          "from": { "id": 123456, "username": "user" },
          "chat": { "id": -1001234567890 }
        }
      },
      "update_id": 123
    }
  ]
}
```

The `payload` contains the standard [Telegram Update object](https://core.telegram.org/bots/api#update). Basic authentication is supported via URL credentials (`https://user:pass@example.com/updates`).

## Usage

### Basic Usage

```bash
opencode-telegram-mirror [directory] [session-id]
```

- `directory`: Working directory (defaults to current directory)
- `session-id`: Existing OpenCode session ID to resume

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `TELEGRAM_BOT_TOKEN` | Bot token from [@BotFather](https://t.me/BotFather) | Yes |
| `TELEGRAM_CHAT_ID` | Chat ID from [@userinfobot](https://t.me/userinfobot) | Yes |
| `TELEGRAM_THREAD_ID` | Thread/topic ID for forum channels | No |
| `TELEGRAM_UPDATES_URL` | Central updates endpoint for multi-instance deployments | No |
| `TELEGRAM_SEND_URL` | Custom Telegram API endpoint (defaults to api.telegram.org) | No |
| `OPENCODE_URL` | External OpenCode server URL (if not set, spawns local server) | No |

### Configuration Files

The bot loads configuration from (in order of priority):

1. Environment variables (highest priority)
2. `~/.config/opencode/telegram.json`
3. `<repo>/.opencode/telegram.json`

Example config file:
```json
{
  "botToken": "your-bot-token",
  "chatId": "your-chat-id",
  "threadId": 123,
  "sendUrl": "https://api.telegram.org/bot",
  "updatesUrl": "https://your-durable-object-endpoint"
}
```

## Advanced Features

### Session Control

Send messages in Telegram to interact with OpenCode:
- **Text messages**: Sent as prompts to OpenCode
- **Photos**: Attached as image files to prompts
- **"x"**: Interrupt the current session
- **"/connect"**: Get the OpenCode server URL

### Interactive Controls

The bot provides inline keyboard controls for:
- **Interrupt**: Stop the current session
- **Mode switching**: Toggle between "plan" and "build" modes
- **Questions**: Answer multiple-choice questions from OpenCode
- **Permissions**: Grant/deny file access permissions

### Diff Viewer

When OpenCode makes file edits, the bot:
1. Generates a visual diff
2. Uploads it to a diff viewer
3. Shares a link to view the changes

## Development

### Prerequisites

- Node.js 18+
- npm or bun

### Local Development

```bash
# Clone the repo
git clone <repository-url>
cd opencode-telegram-mirror

# Install dependencies
bun install

# Run in development
bun run start

# Run tests
bun run test:run
```

### Building

```bash
# Type check
bun run typecheck

# Run mock server for testing
bun run test:mock-server
```

## Why Telegram?

- **Cross-platform**: Works on any device with Telegram
- **Instant sync**: Real-time message delivery
- **Rich formatting**: Markdown, code blocks, and media support
- **Free**: No rate limits or costs
- **Persistent**: Message history is always available

## License

[Add your license here]