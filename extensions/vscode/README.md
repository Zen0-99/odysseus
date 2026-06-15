# Odysseus VS Code Extension

Connect to your local Odysseus AI workspace directly from VS Code.

## Features

- **Chat panel** — Ask questions and get streaming responses from Odysseus
- **Session management** — Create and switch between chat sessions
- **Secure connection** — Uses Bearer token auth (`ody_` tokens)

## Setup

1. Install the extension
2. Open **Odysseus: Connect** from the Command Palette (`Ctrl+Shift+P`)
3. Configure settings:
   - `odysseus.host` — your Odysseus URL (default: `http://127.0.0.1:7860`)
   - `odysseus.apiToken` — your `ody_` API token
   - `odysseus.model` — default model to use
4. Click the Odysseus icon in the Activity Bar to open the chat panel

## Commands

| Command | Description |
|---------|-------------|
| `Odysseus: Chat` | Open the chat panel |
| `Odysseus: Connect` | Verify connection to Odysseus |

## Development

```bash
npm install
npm run compile
# Press F5 in VS Code to launch Extension Development Host
```

## License

Same as Odysseus
