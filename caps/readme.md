# PlatoKit Apps

Each app is a single `.html` file. No install, no build, no dependencies.

## How to Use

### Online (drag and drop)

1. Open your PlatoKit workspace: **[algchain.github.io/algkit/platokit.html](https://algchain.github.io/algkit/platokit.html)**
2. Browse the apps below or in the sidebar
3. Drag any `.html` file from this repo into a workspace slot
4. The app loads instantly in a sandboxed viewport

### Offline (download and go)

1. Save `platokit.html` to your computer (right-click, Save As)
2. Download any app `.html` files you want
3. Open `platokit.html` from your local files — it works from `file://`
4. Drag your downloaded app files into the workspace
5. Everything runs locally in your browser. No internet needed.

### From GitHub directly

You can also drag `.html` files straight from the GitHub file browser into your running PlatoKit workspace. The hub will fetch the raw content and load it.

## Available Apps

### Core Tools

| App | File | What It Does |
|-----|------|-------------|
| AI Chat | [`chat_gateway-allenai_kit.html`](chats/chat_gateway-allenai_kit.html) | Private AI chat powered by Allen AI via Puter.js. Your prompts never leave your browser. |
| Video Call | [`chat_video_kit.html`](chat_video/chat_video_kit.html) | Peer-to-peer encrypted video and text chat. WebRTC direct connection, MQTT signaling. No server sees your call. |
| Help Hotline | [`help_hotline_kit.html`](help/help_hotline_kit.html) | Submit help requests that route to chat, AI, or storage. |
| Search | [`search_main_kit.html`](base_pages/search_main_kit.html) | Discover all available apps, methods, and integration recipes. |
| Storage | [`store_local_kit.html`](base_pages/store_local_kit.html) | Persistent key-value storage using your browser's localStorage. Data stays on your machine. |
| Message Bus | [`msg_send_kit.html`](base_pages/msg_send_kit.html) | Broadcast messages between apps. The backbone that lets tools talk to each other. |
| Export | [`platokit_export_ui.html`](../platokit_export_ui.html) | Save your entire workspace as HTML, JSON, or a bookmarklet you can run anywhere. |

### Sample Apps (learn by example)

These are minimal working examples — great starting points for building your own.

| App | File | What It Does |
|-----|------|-------------|
| Ping | [`sample_ping.html`](caps_samples/sample_ping.html) | Simplest possible app. Responds to ping with pong. Start here. |
| Echo | [`sample_echo.html`](caps_samples/sample_echo.html) | Echoes back any message. Shows the message-passing pattern. |
| Clock | [`sample_clock.html`](caps_samples/sample_clock.html) | Real-time clock display. Shows how to run continuous UI updates. |
| Counter | [`sample_counter.html`](caps_samples/sample_counter.html) | Increment/decrement with state. Shows interactive UI + state management. |
| Storage | [`sample_storage.html`](caps_samples/sample_storage.html) | Basic localStorage wrapper. Shows how to persist data. |

### Standalone Demos

| File | What It Does |
|------|-------------|
| [`SAMPLE-CHAT_VIDEO_KIT.html`](../SAMPLE-CHAT_VIDEO_KIT.html) | Self-contained video call demo. Download this single file and open it in a browser to try PlatoKit-style apps without the full workspace. |

## Build Your Own

Every app is just an HTML file with a header and a message handler. See [`how_to_add_cap.md`](../how_to_add_cap.md) for the full guide.

The minimum viable app:

```html
<!--@platokit-cap
name: my-app
kind: sample
version: 1.0.0
author: your-github-username
description: What your app does
provides:
  - myapp.hello
requires: []
-->
<!DOCTYPE html>
<html>
<body>
  <h1>My App</h1>
  <script>
    window.addEventListener('message', function(e) {
      if (e.data.method === 'myapp.hello') {
        e.source.postMessage({
          kind: 'response',
          id: e.data.id,
          result: 'Hello from my app!'
        }, '*');
      }
    });
    // Tell the hub we're ready
    parent.postMessage({ kind: 'cap_ready', methods: ['myapp.hello'] }, '*');
  </script>
</body>
</html>
```

Save that as `sample_my-app.html`, drag it into your workspace, and it works.

## Privacy

Every app runs in a sandboxed `<iframe>` with restricted permissions. Apps cannot:
- Access your filesystem
- Read other apps' data
- Make network requests (unless explicitly granted)
- Escape the sandbox

Your data stays in your browser. Period.
