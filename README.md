# PlatoKit: Build Capable Worlds

A private App Store for your browser. Drag and drop curated open-source tools and use them in a private sandbox — even when offline. It's **one HTML file**.

**<a href="https://algchain.github.io/algkit/platokit.html" target="_blank">Open Your Toolkit</a>** | [Drag this addon sample](https://raw.githubusercontent.com/algchain/algkit/refs/heads/main/caps/chats/chat_gateway-allenai_kit.html) | [Browse Apps](https://github.com/algchain/algkit/blob/main/caps/readme.md)

---

## What Can You Do?

- **Chat with friends** over your own encrypted video channel — no sign-up, no middleman.
- **Use your own AI chatbot** to process confidential documents privately in your browser.
- **Ask for help** from reputable GitHub contributors, or browse curated tools from the community.
- **Build custom apps** from single-prompt descriptions — each tool is one `.html` file.
- **Skin your workspace** — create your own look-alike Instagram, news feed, or dashboard.
- **Modify any website with one click** — filter spam posts, remove clutter, reshape pages.
- **Automate with browser AI agents** — document creation, data extraction, editing workflows.

### Examples

- Auto-convert PDF bank statements into a workable spreadsheet via OCR and a custom extractor tool
- Filter social media feeds to show only content from people you actually follow
- Run a private LLM chat that never sends your data to a third party
- Set up a peer-to-peer video call room with no accounts and no server


<p align="center">
  <img src="assets/media/screen demo normal medium.png" width="700" alt="My diagram">
</p>

---

<h2>How It Works</h2>

<table style="border-collapse:collapse; border:none;">
  <tr>
    <td valign="top" width="50%">
      <ol>
        <li><b>Open <code>platokit.html</code></b> in any browser — from a local file, a USB drive, or the live link above.</li>
        <li><b>Drag and drop</b> <code>.html</code> tool files into your workspace, or pick from the sidebar.</li>
        <li><b>Tools run sandboxed</b> in your browser. No installs, no servers, no tracking.</li>
        <li><b>Share tools</b> by sharing files. Fork this repo to build your own toolkit.</li>
      </ol>
      <p>
        Each tool is a standalone <code>.html</code> capability file. You can inspect the source, modify it, or write your own.
        PlatoKit loads them into isolated sandboxes and wires them together via message passing.
      </p>
      <p><b>Want to make this better? <a href="https://github.com/algchain/algkit">Contribute directly to this repo</a> with your own tools or designs.</b></p>
    </td>
    <td valign="middle" width="38%" align="right">
      <img src="assets/media/swipe%201mb%20webp.webp" width="320" alt="Swipe demo">
    </td>
  </tr>
</table>

---
<h2>Included Tools</h2>


<table style="border-collapse:collapse; border:none;">
  <tr>
    <td valign="top" width="55%">
      <table>
        <tr>
          <th align="left">Tool</th>
          <th align="left">What It Does</th>
        </tr>
        <tr><td><b>AI Chat</b></td><td>Chat with Allen AI language models, privately via Puter.js</td></tr>
        <tr><td><b>Video Call</b></td><td>Peer-to-peer encrypted video/text chat (WebRTC + MQTT)</td></tr>
        <tr><td><b>Help Hotline</b></td><td>Submit help requests, routed to chat or AI</td></tr>
        <tr><td><b>Search</b></td><td>Discover and browse all available tools</td></tr>
        <tr><td><b>Storage</b></td><td>Key-value storage that persists across sessions</td></tr>
        <tr><td><b>Message Bus</b></td><td>Broadcast messages between tools</td></tr>
        <tr><td><b>Export</b></td><td>Save your workspace as HTML, JSON, or a bookmarklet</td></tr>
        <tr><td><b>Samples</b></td><td>Ping, echo, clock, counter, storage — starter examples to learn from</td></tr>
      </table>
    </td>
    <td valign="top" width="38%" align="right">
      <img src="assets/media/screen%20demo%20apps%20paint.png" width="450" alt="Demo apps">
    </td>
  </tr>
</table>


---

## For Developers

Repo contributions welcomed! Re-skin the UI, add more micro-apps, link your own code and let's make best-in-class tools available to everyone. After all, a single-page smart contract can change an entire industry.

<details open>
<summary>Project structure, naming conventions, and how to add tools</summary>

### Structure

```
platokit.html                   Main hub (open this)
caps/
  chats/                        Chat capabilities
  chat_video/                   Video call capability
  help/                         Help system
  base_pages/                   Core services (search, store, msg)
  caps_samples/                 Sample/demo capabilities
hubskins/
  skin_hub.html                 Studio skin (sidebar + viewport layout)
js/
  skin_manager.js               Skin system module
  platokit_debug.js             WebSocket debug bridge
platokit_compiler.js            Workspace compiler (export)
platokit_export_ui.html         Export UI
cap_manifest.json               Auto-generated manifest of all caps
```

### Capability Naming

All tools follow the naming convention:

```
kind_name.html          (standard)
kind_name_kit.html      (released, substantial)
```

Each cap has a `<!--@platokit-cap ...-->` header with identity, versioning, integrity hash, and lineage metadata. See [`file_naming.md`](file_naming.md) for the full protocol.

### Adding Your Own Tool

See [`how_to_add_cap.md`](how_to_add_cap.md) for the full guide. The short version:

1. Create a single `.html` file with a `<!--@platokit-cap` header
2. Handle `postMessage` events from the hub
3. Drop it into `caps/` and add it to the manifest

### Dev View

Add `?hub=true` to the URL to see the raw debug workspace with dev toolbar, load sets, and system logs.

### Running Tests

```bash
python RUN_tests.py --quick
```

</details>

---

## License

MIT


