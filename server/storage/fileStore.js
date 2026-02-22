const fs = require('fs');
const path = require('path');

function resolveDbPath() {
  if (process.env.DB_PATH) return path.resolve(process.env.DB_PATH);
  return path.join(__dirname, '..', 'data', 'db.json');
}

class FileStore {
  constructor() {
    this.dbPath = resolveDbPath();
    this.dbRoot = path.dirname(this.dbPath);
  }

  async init() {
    if (!fs.existsSync(this.dbRoot)) {
      fs.mkdirSync(this.dbRoot, { recursive: true });
    }
  }

  async loadDB() {
    try {
      const raw = fs.readFileSync(this.dbPath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        machines: Array.isArray(parsed?.machines) ? parsed.machines : [],
        tasks: Array.isArray(parsed?.tasks) ? parsed.tasks : [],
        history: Array.isArray(parsed?.history) ? parsed.history : [],
      };
    } catch {
      return { machines: [], tasks: [], history: [] };
    }
  }

  async saveDB(db) {
    await this.init();
    fs.writeFileSync(this.dbPath, JSON.stringify(db, null, 2), 'utf8');
  }
}

module.exports = {
  FileStore,
};
