const Anthropic = require('@anthropic-ai/sdk');

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

async function searchKbWithAI(query) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key === 'your_anthropic_api_key_here') {
    return { articles: [], videos: [], error: 'ANTHROPIC_API_KEY not configured. Add your key to backend/.env' };
  }
  try {
    const ai = getClient();
    const message = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are a technical support knowledge base assistant. A customer has the following issue:

"${query}"

Provide:
1. 3-4 relevant help articles with titles, brief solutions, and real documentation URLs (use actual URLs from official docs like Google, Microsoft, AWS, Cloudflare, etc.)
2. 2-3 relevant YouTube video search queries they could use to find tutorials

Respond ONLY with valid JSON in this exact format:
{
  "articles": [
    {
      "title": "Article title",
      "solution": "Brief 1-2 sentence solution",
      "url": "https://actual-docs-url.com/page",
      "source": "Source name e.g. Google Workspace Help"
    }
  ],
  "videos": [
    {
      "query": "YouTube search query for this topic",
      "title": "What this video would cover"
    }
  ]
}`,
      }],
    });

    const text = message.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      articles: parsed.articles || [],
      videos: (parsed.videos || []).map(v => ({
        ...v,
        searchUrl: `https://www.youtube.com/results?search_query=${encodeURIComponent(v.query)}`,
      })),
    };
  } catch (err) {
    console.error('[AI KB error]', err.message);
    return { articles: [], videos: [], error: 'AI search failed' };
  }
}

module.exports = { searchKbWithAI };
