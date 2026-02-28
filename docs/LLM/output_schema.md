# LLM Output Schema

This document describes the output format supported by Waypoint's UI for displaying LLM responses, including thinking/reasoning content.

## Overview

Waypoint's Playground UI supports displaying thinking process from LLMs that provide reasoning content. The system handles both:

1. **Native reasoning fields** from LLM APIs (e.g., DeepSeek's `reasoning_content`)
2. **HTML-style tags** embedded in the response text

## Supported Thinking Formats

### 1. Native API Fields

Some LLM providers include reasoning content in separate fields of the streaming response:

| Provider | Field Name | Example |
|----------|------------|---------|
| DeepSeek | `reasoning_content` | `choices[0].delta.reasoning_content` |
| Other providers | `reasoning` | `choices[0].delta.reasoning` |

The Waypoint backend automatically extracts these fields and the frontend wraps them in `  ` tags for display.

### 2. HTML-Style Tags

LLMs can also output thinking content wrapped in HTML-like tags:

```
  
This is my thinking process...
Step 1: Analyze the problem
Step 2: Consider solutions
  

This is the final response based on my reasoning above.
```

The UI recognizes these tags and renders the thinking content in a collapsible "Thinking process" block.

## Streaming Response Format

When `stream: true` is enabled, the API returns Server-Sent Events (SSE) with the following structure:

### Standard OpenAI Format

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion.chunk",
  "created": 1234567890,
  "model": "gpt-4",
  "choices": [
    {
      "index": 0,
      "delta": {
        "content": "Hello",
        "reasoning_content": "I should greet the user warmly"
      },
      "finish_reason": null
    }
  ]
}
```

### Frontend Processing

The frontend processes each chunk:

1. Extracts `content` (regular response text)
2. Extracts `reasoning_content` or `reasoning` (thinking process)
3. Wraps reasoning in `  ` tags when transitioning from reasoning to content
4. Combines both into the display message

Example flow:

```
Chunk 1: { reasoning: "Let me think..." }           → Display: "  Let me think..."
Chunk 2: { reasoning: "Step 1: Analyze" }           → Display: "  Let me think...Step 1: Analyze"
Chunk 3: { content: "Based on my analysis" }        → Display: "  Let me think...Step 1:Analyze  \n\nBased on my analysis"
```

## Display Behavior

### Thinking Block UI

When the UI detects `  ... ` content, it renders:

- A collapsible block with a "Thinking process" header
- Brain icon and expand/collapse chevron
- Monospace font for the thinking content
- Collapsed by default to focus on the main response

### Parsing Logic

The `MessageContent` component handles three edge cases:

1. **Standard format**: `  ...content... ` - Properly tagged thinking
2. **Missing opening tag**: Content before ` ` is treated as thinking
3. **Unclosed tag**: `  ...` during streaming (tag will be closed when content arrives)

## Supported Models

The following models are known to provide reasoning content:

| Model | Reasoning Field | Notes |
|-------|----------------|-------|
| DeepSeek-R1 | `reasoning_content` | Chain-of-thought reasoning |
| DeepSeek-V3 | `reasoning_content` | Extended thinking mode |
| Other reasoning models | `reasoning` | Generic field support |

Models that output `  ` tags in their response (like some Qwen or Llama variants) will also have their thinking content displayed correctly.

## Implementation Details

### Backend (`src/routes/responses.ts`)

The Responses API shim handles reasoning content from Codex-formatted requests:

```typescript
if (delta.reasoning_content || delta.reasoning) {
  const reasoningDelta = delta.reasoning_content || delta.reasoning;
  sendEvent("response.reasoning_text.delta", {
    type: "response.reasoning_text.delta",
    delta: reasoningDelta
  });
}
```

### Frontend (`ui/src/api/client.ts`)

The streaming client extracts both content and reasoning:

```typescript
const delta = parsed.choices?.[0]?.delta;
const content = delta?.content;
const reasoning = delta?.reasoning_content || delta?.reasoning;

if (content || reasoning) {
  yield { content: content || '', reasoning: reasoning || undefined };
}
```

### Playground (`ui/src/pages/Playground.tsx`)

The Playground component tracks reasoning and content separately, then combines them:

```typescript
if (chunk.reasoning) {
  if (!hasReasoning) {
    reasoningContent = '  ' + chunk.reasoning;
  } else {
    reasoningContent += chunk.reasoning;
  }
}

if (chunk.content && hasReasoning && !reasoningClosed) {
  reasoningContent += '  ';
  reasoningClosed = true;
}
```

## Testing

To verify thinking content display:

1. Use a model that supports reasoning (e.g., DeepSeek-R1)
2. Send a complex question requiring multi-step reasoning
3. Observe the "Thinking process" collapsible block appears
4. Expand to see the reasoning content
5. Verify the final response follows the thinking block

Example test prompt:

```
If a train travels 120 km in 2 hours, then stops for 30 minutes, 
then continues at the same speed for another 90 km, 
what is the total travel time?
```

Models with reasoning capability will show their calculation steps in the thinking block before providing the final answer.

## Future Enhancements

- Support for multiple thinking blocks in a single response
- Configurable thinking display (always show/hide by default)
- Token count display for reasoning vs. response content
- Export thinking content separately from the final response

## Codex CLI Specific Schema

Codex CLI uses a custom event-based protocol rather than the standard OpenAI API format. The Waypoint proxy must transform standard API responses to match Codex's expectations.

### Key Differences from Standard API

| Feature | Standard OpenAI | Codex CLI |
|---------|----------------|-----------|
| Reasoning Content | Embedded in `delta.content` or separate field | Dedicated `AgentReasoningDeltaEvent` events |
| Tool Calls | Standard `tool_calls` array | Custom `McpToolCallBeginEvent`/`McpToolCallEndEvent` |
| Command Execution | Not supported | Special `ExecCommandBeginEvent`/`ExecCommandEndEvent` |
| Model Requirements | Standard names | Specific names like `gpt-5.1-codex-mini` |

### Codex-Specific Event Types

Codex CLI expects the following event types in the stream:

```typescript
// Reasoning content
interface AgentReasoningDeltaEvent {
  type: 'agent_reasoning_delta';
  delta: string;
}

// Raw reasoning content (for internal processing)
interface AgentReasoningRawContentDeltaEvent {
  type: 'agent_reasoning_raw_content_delta';
  delta: string;
}

// Regular message content
interface AgentMessageDeltaEvent {
  type: 'agent_message_delta';
  delta: string;
}

// Tool calls
interface McpToolCallBeginEvent {
  type: 'mcp_tool_call_begin';
  name: string;
  arguments: object;
}

interface McpToolCallEndEvent {
  type: 'mcp_tool_call_end';
  result: string;
}

// Command execution
interface ExecCommandBeginEvent {
  type: 'exec_command_begin';
  command: string;
  source: 'user' | 'agent';
}

interface ExecCommandEndEvent {
  type: 'exec_command_end';
  exit_code: number;
  output: string;
}
```

### Proxy Transformation Rules

The Waypoint proxy handles the translation between standard OpenAI format and Codex's custom protocol:

1. **Reasoning Content Extraction**
   - When `reasoning_content` or `reasoning` fields are detected, they're converted to `AgentReasoningDeltaEvent`
   - Example: `{"delta": {"reasoning_content": "Thinking step..."}}` → `{"type": "agent_reasoning_delta", "delta": "Thinking step..."}`

2. **Special Model Handling**
   - Requests to `gpt-5.1-codex-mini` are routed to specific endpoints
   - Other Codex-specific models are transformed to match backend requirements

3. **Tool Call Conversion**
   - Standard tool calls are converted to `McpToolCallBeginEvent`/`McpToolCallEndEvent` sequence
   - Custom tool parameters are preserved

### Implementation in Waypoint

The proxy implements these transformations in `src/routes/responses.ts`:

```typescript
// Convert OpenAI tool calls to Codex MCP events
if (delta.tool_calls) {
  delta.tool_calls.forEach(toolCall => {
    sendEvent("mcp_tool_call_begin", {
      type: "mcp_tool_call_begin",
      name: toolCall.function.name,
      arguments: JSON.parse(toolCall.function.arguments)
    });
  });
}

// Handle reasoning content from various sources
if (delta.reasoning_content || delta.reasoning) {
  const reasoningDelta = delta.reasoning_content || delta.reasoning;
  sendEvent("response.reasoning_text.delta", {
    type: "response.reasoning_text.delta",
    delta: reasoningDelta
  });
}
```

### Testing with Codex CLI

To verify Codex CLI compatibility:

1. Set the model to `gpt-5.1-codex-mini` in your settings
2. Enable reasoning mode if available
3. Send a complex prompt requiring multi-step reasoning
4. Verify the thinking process appears in dedicated blocks
5. Test tool calling with `@mcp` commands

Example Codex CLI prompt:

```
@model gpt-5.1-codex-mini
@reasoning
Explain step by step how you would calculate the area of a triangle with sides 3, 4, and 5.
```

The proxy should properly route this request and format the response to match Codex's event structure, with reasoning content separated from the final answer.
