# Reddit Post for r/LocalLLaMA

## Title
Waypoint v0.6.0 - Local AI Gateway with Built-in MCP Tools for Image Gen & Vision (OpenAI-Compatible Proxy + Playground)

## Body

Hey r/LocalLLaMA! 

Released [Waypoint v0.6.0](https://github.com/zziang/waypoint/releases/tag/v0.6.0) - it's a local AI gateway that unifies multiple LLM/diffusion/audio endpoints behind one OpenAI-compatible proxy at `localhost:8000/v1`.

**What's new in 0.6.0:**

🛠️ **Built-in MCP Service** - Two tools right out of the box:
- `generate_image` - Chat → image, files written to workspace
- `understand_image` - Upload image → get structured analysis

🤖 **Agent Mode** - Toggle it on, pick tools, agent uses them automatically (10 iterations max per message)

📊 **Token Flow Sankey** - Visualize where tokens went in Peek

**Core stuff (since 0.4.0):**
- Health-based failover across endpoints
- Provider-first config (`waypoint providers import -f .env`)
- Real-time dashboard (latency, tokens, errors)
- Peek request inspector (calendar + timeline)
- Built-in React playground

**Why I built it:**
Sometimes a good LLM endpoint works behind a bad SSL cert. Or you want to route "smart" across multiple backends. Waypoint handles the mess so your client just talks to `localhost:8000/v1`.

**Quickstart:**
```bash
git clone https://github.com/zziang/waypoint
cd waypoint && npm install
cd ui && npm install && cd ..
npm run build:all && npm run start
```
Hit `http://localhost:8000/ui`

Check the [release](https://github.com/zziang/waypoint/releases/tag/v0.6.0) for screenshots and docs. Feedback welcome! 🚀

---

**TL;DR:** Local proxy for LLMs/diffusion/audio with OpenAI-compatible API, now with built-in MCP tools for image generation and understanding.
