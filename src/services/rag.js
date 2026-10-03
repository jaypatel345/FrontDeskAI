import fs from 'node:fs';
import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config.js';

const kbPath = new URL('../../kb/clinicKnowledgeBase.json', import.meta.url);
const localKb = JSON.parse(fs.readFileSync(kbPath, 'utf-8'));

const useVectorSearch = Boolean(config.openaiApiKey);

let openai = null;
let qdrant = null;
if (useVectorSearch) {
  const { default: OpenAI } = await import('openai');
  openai = new OpenAI({ apiKey: config.openaiApiKey });
  qdrant = new QdrantClient({ url: config.qdrant.url, apiKey: config.qdrant.apiKey || undefined });
}

export async function searchKnowledgeBase(query, topK = 3) {
  if (useVectorSearch) {
    const embedding = await embed(query);
    const hits = await qdrant.search(config.qdrant.collection, {
      vector: embedding,
      limit: topK,
    });
    return hits.map((h) => ({ id: h.payload.id, category: h.payload.category, text: h.payload.text, score: h.score }));
  }

  return keywordSearch(query, topK);
}

export async function embed(text) {
  const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text });
  return res.data[0].embedding;
}

function keywordSearch(query, topK) {
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
  const scored = localKb.map((entry) => {
    const haystack = entry.text.toLowerCase();
    const score = terms.reduce((acc, t) => acc + (haystack.includes(t) ? 1 : 0), 0);
    return { ...entry, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0).slice(0, topK);
}

export const ragMode = useVectorSearch ? 'qdrant + openai embeddings (live)' : 'local keyword search (no OPENAI_API_KEY set)';
