import fs from 'node:fs';
import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../config.js';
import { getIndustry } from '../industries/registry.js';

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

export function getCollectionName(industryKey = 'clinic') {
  const clean = String(industryKey).replace(/-/g, '_');
  return clean === 'clinic' ? config.qdrant.collection : `${clean}_kb`;
}

export async function searchKnowledgeBase(query, topK = 3, industryKey = 'clinic') {
  const industry = getIndustry(industryKey);
  const targetCollection = getCollectionName(industry.id);

  if (useVectorSearch) {
    try {
      const embedding = await embed(query);
      const hits = await qdrant.search(targetCollection, {
        vector: embedding,
        limit: topK,
      });
      return hits.map((h) => ({ id: h.payload.id, category: h.payload.category, text: h.payload.text, score: h.score }));
    } catch {
      // Fallback to keyword search if vector collection not seeded
      return keywordSearch(query, topK, industry.knowledgeBase);
    }
  }

  return keywordSearch(query, topK, industry.knowledgeBase);
}

export async function embed(text) {
  const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text });
  return res.data[0].embedding;
}

function keywordSearch(query, topK, kbEntries = localKb) {
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
  const scored = kbEntries.map((entry) => {
    const haystack = entry.text.toLowerCase();
    const score = terms.reduce((acc, t) => acc + (haystack.includes(t) ? 1 : 0), 0);
    return { ...entry, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0).slice(0, topK);
}

export const ragMode = useVectorSearch ? 'qdrant + openai embeddings (live)' : 'local keyword search (no OPENAI_API_KEY set)';

