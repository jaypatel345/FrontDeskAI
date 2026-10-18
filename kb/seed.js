import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../src/config.js';
import { listIndustries, normalizeIndustryKey, getIndustry } from '../src/industries/registry.js';
import { getCollectionName } from '../src/services/rag.js';

if (!config.openaiApiKey) {
  console.log('No OPENAI_API_KEY set — nothing to seed. RAG will use local keyword search instead.');
  process.exit(0);
}

const { default: OpenAI } = await import('openai');
const openai = new OpenAI({ apiKey: config.openaiApiKey });
const qdrant = new QdrantClient({ url: config.qdrant.url, apiKey: config.qdrant.apiKey || undefined });

function hashId(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return hash;
}

async function seedIndustry(industry) {
  const collectionName = getCollectionName(industry.id);
  console.log(`\n--- Seeding Knowledge Base for [${industry.id}]: Collection "${collectionName}" ---`);

  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c) => c.name === collectionName);
  if (!exists) {
    await qdrant.createCollection(collectionName, {
      vectors: { size: 1536, distance: 'Cosine' },
    });
    console.log(`Created collection "${collectionName}"`);
  }

  const points = [];
  for (const entry of industry.knowledgeBase) {
    const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: entry.text });
    points.push({
      id: hashId(`${industry.id}-${entry.id}`),
      vector: res.data[0].embedding,
      payload: entry,
    });
    console.log(`Embedded [${industry.id}]: ${entry.id}`);
  }

  await qdrant.upsert(collectionName, { points });
  console.log(`Seeded ${points.length} entries into collection "${collectionName}".`);
}

async function main() {
  const rawArg = process.argv[2] ? process.argv[2].replace(/^--industry=/, '').trim().toLowerCase() : null;

  if (rawArg === 'all') {
    for (const industry of listIndustries()) {
      await seedIndustry(industry);
    }
  } else if (rawArg) {
    const norm = normalizeIndustryKey(rawArg);
    if (!norm) {
      console.error(`Unknown industry "${rawArg}".`);
      process.exit(1);
    }
    await seedIndustry(getIndustry(norm));
  } else {
    // Default: seed all 3 so every demo is ready
    for (const industry of listIndustries()) {
      await seedIndustry(industry);
    }
  }

  console.log('\nSeeding complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

