const Database = require('better-sqlite3');
const db = new Database('D:/VCPToolBox-Official/VectorStore/knowledge_base.sqlite', { readonly: true });

console.log('========================================');
console.log('7. CHUNK ID GAP ANALYSIS (4609 → 7933)');
console.log('========================================');

// How many chunks exist in the DB total vs the ID range?
const totalChunks = db.prepare('SELECT COUNT(*) as cnt FROM chunks').get();
const maxId = db.prepare('SELECT MAX(id) as maxid FROM chunks').get();
const minId = db.prepare('SELECT MIN(id) as minid FROM chunks').get();

console.log(`Total chunks in DB: ${totalChunks.cnt}`);
console.log(`Chunk ID range: ${minId.minid} - ${maxId.maxid}`);
console.log(`Expected IDs if no gaps: ${maxId.maxid - minId.minid + 1}`);
console.log(`Missing IDs: ${(maxId.maxid - minId.minid + 1) - totalChunks.cnt}`);

// The big gap is between 4609 and 7933 - what happened?
// Check chunks in the range around the gap
const justBeforeGap = db.prepare('SELECT id, file_id FROM chunks WHERE id >= 4600 ORDER BY id DESC LIMIT 15').all();
const justAfterGap = db.prepare('SELECT id, file_id FROM chunks WHERE id <= 7940 ORDER BY id ASC LIMIT 15').all();

console.log('\nLast chunks before the gap:');
justBeforeGap.forEach(c => {
  const f = db.prepare('SELECT diary_name FROM files WHERE id = ?').get(c.file_id);
  console.log(`  id=${c.id} file_id=${c.file_id} diary="${f ? f.diary_name : '???'}"`);
});

console.log('\nFirst chunks after the gap:');
justAfterGap.forEach(c => {
  const f = db.prepare('SELECT diary_name FROM files WHERE id = ?').get(c.file_id);
  console.log(`  id=${c.id} file_id=${c.file_id} diary="${f ? f.diary_name : '???'}"`);
});

// Are the ghost IDs 7779, 6685 in the gap?
console.log('\nGhost IDs 7779 and 6685 are within the gap (4609-7933)');
console.log('This means chunks were deleted from SQLite but the usearch index still references them.');

console.log('\n========================================');
console.log('8. HOW MANY ENTRIES PER INDEX (EXACT)');
console.log('========================================');

// Let's check the sqlite_sequence - the auto-increment counter
// If the counter was reset, that explains the gap
const seq = db.prepare("SELECT * FROM sqlite_sequence").all();
console.log('sqlite_sequence (auto-increment counters):');
seq.forEach(s => console.log(`  ${s.name}: seq=${s.seq}`));

// Check: how many diary folders have chunks with IDs > 4609 and < 7933
// (i.e. in the gap)
const gapChunks = db.prepare('SELECT COUNT(*) as cnt FROM chunks WHERE id > 4609 AND id < 7933').get();
console.log(`\nChunks with IDs in the gap (4610-7932): ${gapChunks.cnt}`);
// This should be 0 if they were deleted

// How many total chunks were deleted?
// Chunks with IDs that could fit in the gap range
const chunksAfterGap = db.prepare('SELECT COUNT(*) as cnt FROM chunks WHERE id >= 7933').get();
console.log(`Chunks with IDs >= 7933: ${chunksAfterGap.cnt}`);

// The 思维簇 chunk IDs are all >= 8372, meaning they were created AFTER the gap
console.log('\n========================================');
console.log('9. TIMELINE RECONSTRUCTION');
console.log('========================================');

// Group chunks by file_id ranges and diary names
const timeline = db.prepare(`
  SELECT f.diary_name, MIN(c.id) as min_chunk, MAX(c.id) as max_chunk, COUNT(c.id) as chunk_count
  FROM chunks c
  JOIN files f ON c.file_id = f.id
  GROUP BY f.diary_name
  ORDER BY min_chunk
`).all();

console.log('Diary folders ordered by first chunk ID:');
timeline.forEach(t => {
  console.log(`  ${t.diary_name}: chunks ${t.min_chunk}-${t.max_chunk} (count=${t.chunk_count})`);
});

db.close();
