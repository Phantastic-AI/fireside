import { buildSeed, assertDistribution } from '../seed/seed';
const t0 = Date.now();
const d = buildSeed();
console.log('buildSeed ms:', Date.now() - t0);
console.log(assertDistribution(d));
console.log('rows:', JSON.stringify(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, (v as unknown[]).length]))));
