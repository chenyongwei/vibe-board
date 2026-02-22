const { createStore } = require('./storage');

async function main() {
  const store = createStore();
  await store.init();

  const now = new Date().toISOString();
  const db = {
    machines: [
      {
        id: 'pc1',
        name: 'PC-Dev-1',
        last_seen: now,
        online_since: now,
        fingerprint: 'pc1',
        aliases: ['pc1'],
      },
      {
        id: 'pc2',
        name: 'PC-Dev-2',
        last_seen: now,
        online_since: now,
        fingerprint: 'pc2',
        aliases: ['pc2'],
      },
    ],
    tasks: [
      {
        id: 't1',
        machine_id: 'pc1',
        title: 'Build MVP dashboard',
        status: 'in_progress',
        created_at: now,
        updated_at: now,
      },
      {
        id: 't2',
        machine_id: 'pc1',
        title: 'Write API docs',
        status: 'completed_pending_verification',
        created_at: now,
        updated_at: now,
      },
    ],
    history: [],
  };

  await store.saveDB(db);
  const backend = String(process.env.STORAGE_BACKEND || '').trim() || 'auto';
  console.log(`Seeded dashboard data (backend=${backend})`);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
