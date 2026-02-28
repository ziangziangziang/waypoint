import { useState } from 'react'
import { 
  ChevronDown, 
  ChevronUp, 
  Copy, 
  Check,
  Terminal,
  Code
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { EndpointType } from '@/api/client'

export interface UsageGuideTarget {
  id: string
  type: EndpointType
  models: Array<{ publicName: string }>
}

type TabId = 'curl' | 'python' | 'nodejs'

interface EndpointUsageGuideProps {
  target: UsageGuideTarget
}

export function EndpointUsageGuide({ target }: EndpointUsageGuideProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<TabId>('curl')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Get the base URL from the current window location
  const baseUrl = typeof window !== 'undefined' 
    ? `${window.location.protocol}//${window.location.host}`
    : 'http://localhost:8000'

  // Get the first model's public name (most common use case)
  const modelName = target.models[0]?.publicName ?? 'model-name'

  const copyToClipboard = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const generateExamples = () => {
    switch (target.type) {
      case 'llm':
        return generateLlmExamples()
      case 'diffusion':
        return generateDiffusionExamples()
      case 'audio':
        return generateAudioExamples()
      case 'embedding':
        return generateEmbeddingExamples()
      default:
        return generateLlmExamples()
    }
  }

  const generateLlmExamples = () => ({
    curl: `curl ${baseUrl}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${modelName}",
    "messages": [
      {"role": "user", "content": "Hello, how are you?"}
    ],
    "stream": false
  }'`,
    python: `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}/v1",
    api_key="not-needed"  # No API key required for local proxy
)

response = client.chat.completions.create(
    model="${modelName}",
    messages=[
        {"role": "user", "content": "Hello, how are you?"}
    ],
    stream=False
)

print(response.choices[0].message.content)`,
    nodejs: `import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: '${baseUrl}/v1',
  apiKey: 'not-needed', // No API key required for local proxy
});

async function main() {
  const response = await client.chat.completions.create({
    model: '${modelName}',
    messages: [
      { role: 'user', content: 'Hello, how are you?' }
    ],
    stream: false,
  });

  console.log(response.choices[0].message.content);
}

main();`,
  })

  const generateDiffusionExamples = () => ({
    curl: `curl ${baseUrl}/v1/images/generations \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${modelName}",
    "prompt": "A beautiful sunset over mountains",
    "n": 1,
    "size": "1024x1024"
  }'`,
    python: `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}/v1",
    api_key="not-needed"
)

response = client.images.generate(
    model="${modelName}",
    prompt="A beautiful sunset over mountains",
    n=1,
    size="1024x1024"
)

print(response.data[0].url)`,
    nodejs: `import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: '${baseUrl}/v1',
  apiKey: 'not-needed',
});

async function main() {
  const response = await client.images.generate({
    model: '${modelName}',
    prompt: 'A beautiful sunset over mountains',
    n: 1,
    size: '1024x1024',
  });

  console.log(response.data[0].url);
}

main();`,
  })

  const generateAudioExamples = () => ({
    curl: `# Text-to-Speech
curl ${baseUrl}/v1/audio/speech \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${modelName}",
    "input": "Hello, this is a test.",
    "voice": "alloy"
  }' \\
  --output speech.mp3

# Speech-to-Text
curl ${baseUrl}/v1/audio/transcriptions \\
  -F "model=${modelName}" \\
  -F "file=@audio.mp3"`,
    python: `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}/v1",
    api_key="not-needed"
)

# Text-to-Speech
response = client.audio.speech.create(
    model="${modelName}",
    input="Hello, this is a test.",
    voice="alloy"
)
response.stream_to_file("speech.mp3")

# Speech-to-Text
with open("audio.mp3", "rb") as f:
    transcription = client.audio.transcriptions.create(
        model="${modelName}",
        file=f
    )
    print(transcription.text)`,
    nodejs: `import OpenAI from 'openai';
import fs from 'fs';

const client = new OpenAI({
  baseURL: '${baseUrl}/v1',
  apiKey: 'not-needed',
});

async function main() {
  // Text-to-Speech
  const mp3 = await client.audio.speech.create({
    model: '${modelName}',
    input: 'Hello, this is a test.',
    voice: 'alloy',
  });
  
  const buffer = Buffer.from(await mp3.arrayBuffer());
  await fs.promises.writeFile('speech.mp3', buffer);

  // Speech-to-Text
  const transcription = await client.audio.transcriptions.create({
    model: '${modelName}',
    file: fs.createReadStream('audio.mp3'),
  });
  
  console.log(transcription.text);
}

main();`,
  })

  const generateEmbeddingExamples = () => ({
    curl: `curl ${baseUrl}/v1/embeddings \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${modelName}",
    "input": "The quick brown fox jumps over the lazy dog"
  }'`,
    python: `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}/v1",
    api_key="not-needed"
)

response = client.embeddings.create(
    model="${modelName}",
    input="The quick brown fox jumps over the lazy dog"
)

print(f"Embedding dimension: {len(response.data[0].embedding)}")
print(f"First 5 values: {response.data[0].embedding[:5]}")`,
    nodejs: `import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: '${baseUrl}/v1',
  apiKey: 'not-needed',
});

async function main() {
  const response = await client.embeddings.create({
    model: '${modelName}',
    input: 'The quick brown fox jumps over the lazy dog',
  });

  console.log('Embedding dimension:', response.data[0].embedding.length);
  console.log('First 5 values:', response.data[0].embedding.slice(0, 5));
}

main();`,
  })

  const examples = generateExamples()

  const tabs: { id: TabId; label: string; icon: React.ElementType }[] = [
    { id: 'curl', label: 'cURL', icon: Terminal },
    { id: 'python', label: 'Python', icon: Code },
    { id: 'nodejs', label: 'Node.js', icon: Code },
  ]

  return (
    <div className="border-t border-border/50">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-4 py-2 flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
      >
        <Code className="w-3.5 h-3.5" />
        <span>Usage Guide</span>
        <span className="flex-1" />
        {isOpen ? (
          <ChevronUp className="w-3.5 h-3.5" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5" />
        )}
      </button>

      {isOpen && (
        <div className="px-4 pb-4 space-y-3 animate-fade-in">
          {/* Models List */}
          <div className="space-y-1">
            <p className="text-2xs font-mono uppercase text-muted-foreground">Available Models</p>
            <div className="flex flex-wrap gap-1">
              {target.models.map((model, i) => (
                <span
                  key={i}
                  className="px-2 py-0.5 bg-secondary rounded text-xs font-mono"
                >
                  {model.publicName}
                </span>
              ))}
            </div>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-1 bg-secondary/50 rounded-md p-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1 text-xs font-mono rounded transition-colors',
                  activeTab === tab.id
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <tab.icon className="w-3 h-3" />
                {tab.label}
              </button>
            ))}
          </div>

          {/* Code Block */}
          <div className="relative group">
            <pre className="bg-zinc-950 text-zinc-100 rounded-lg p-4 text-xs font-mono overflow-x-auto leading-relaxed">
              <code>{examples[activeTab]}</code>
            </pre>
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-2 right-2 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity bg-zinc-800 hover:bg-zinc-700"
              onClick={() => copyToClipboard(examples[activeTab], `${target.id}-${activeTab}`)}
            >
              {copiedId === `${target.id}-${activeTab}` ? (
                <Check className="w-3.5 h-3.5 text-green-400" />
              ) : (
                <Copy className="w-3.5 h-3.5 text-zinc-400" />
              )}
            </Button>
          </div>

          {/* Endpoint Info */}
          <div className="text-2xs text-muted-foreground space-y-0.5">
            <p>
              <span className="font-medium">Base URL:</span>{' '}
              <code className="bg-secondary px-1 py-0.5 rounded">{baseUrl}/v1</code>
            </p>
            <p>
              <span className="font-medium">Endpoint Type:</span>{' '}
              <span className="uppercase">{target.type}</span>
            </p>
            {target.type === 'llm' && (
              <p className="text-muted-foreground/70">
                Supports streaming via <code className="bg-secondary px-1 py-0.5 rounded">stream: true</code>
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
