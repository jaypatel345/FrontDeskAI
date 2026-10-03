import fs from 'node:fs';
import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../src/config.js';

const kb = JSON.parse(fs.readFileSync(new URL('./clinicKnowledgeBase.json', import.meta.url), 'utf-8'));

if (!config.openaiApiKey) {
  console.log('No OPENAI_API_KEY set — nothing to seed. RAG will use local keyword search instead.');
  process.exit(0);
}

const { default: OpenAI } = await import('openai');
const openai = new OpenAI({ apiKey: config.openaiApiKey });
const qdrant = new QdrantClient({ url: config.qdrant.url, apiKey: config.qdrant.apiKey || undefined });

async function main() {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c) => c.name === config.qdrant.collection);
  if (!exists) {
    await qdrant.createCollection(config.qdrant.collection, {
      vectors: { size: 1536, distance: 'Cosine' },
    });
    console.log(`Created collection "${config.qdrant.collection}"`);
  }

  const points = [];
  for (const entry of kb) {
    const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: entry.text });
    points.push({
      id: hashId(entry.id),
      vector: res.data[0].embedding,
      payload: entry,
    });
    console.log(`Embedded: ${entry.id}`);
  }

  await qdrant.upsert(config.qdrant.collection, { points });
  console.log(`Seeded ${points.length} knowledge base entries into Qdrant.`);
}

function hashId(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return hash;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
