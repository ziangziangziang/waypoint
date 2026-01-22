# Changelog

All notable changes to Waypoint will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **App icon & favicon** - Custom Waypoint icon in multiple sizes (16, 32, 180, 192, 512px) with apple-touch-icon support
- **Markdown rendering** in chat responses with full GitHub Flavored Markdown support
- **Mermaid diagram support** - code blocks with `mermaid` language are rendered as interactive diagrams
- **Collapsible thinking blocks** - `<think>...</think>` content is displayed in a collapsible "Thinking process" section
- **Copy raw button** - hover over any assistant message to copy the raw markdown content
- **Code block copy buttons** - each code block has a copy button with syntax highlighting

### Fixed

- **MCP Accept header** - fixed MCP client to send `Accept: application/json, text/event-stream` per Streamable HTTP spec
- **MCP SSE response parsing** - added proper parsing for `event: message\ndata: {...}` response format
- **Tool choice compatibility** - removed `tool_choice: "auto"` from requests for vLLM backend compatibility
- **MCP auto-connect on startup** - tools are now discovered automatically when Waypoint starts, fixing "Tool not found" errors after restart
- **Thinking block parsing** - handles responses that start with thinking content without opening `<think>` tag (common with Qwen3 models)
- **Mermaid rendering errors** - added `suppressErrorRendering`, debounced rendering (300ms), and DOM cleanup to prevent error SVGs from appearing during streaming
- **Chat input jumping** - replaced `scrollIntoView` with direct `scrollTop` manipulation and `requestAnimationFrame` for smooth, jitter-free auto-scrolling
- **Mermaid re-triggering** - wrapped `MessageContent` component with `memo` to prevent unnecessary re-renders when typing in chat box

### Changed

- **ThinkingBlock overflow** - added horizontal scroll for long lines in thinking block content
- **Scroll behavior** - only auto-scrolls when user is near bottom (within 150px), allowing users to scroll up without jumping back
