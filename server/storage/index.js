const { FileStore } = require('./fileStore');
const { MySQLStore } = require('./mysqlStore');

function resolveBackend() {
  const explicit = String(process.env.STORAGE_BACKEND || '').trim().toLowerCase();
  if (explicit === 'mysql' || explicit === 'file') return explicit;

  if (process.env.DB_HOST || process.env.MYSQL_HOST) {
    return 'mysql';
  }

  return 'file';
}

function createStore() {
  const backend = resolveBackend();
  if (backend === 'mysql') {
    return new MySQLStore();
  }
  return new FileStore();
}

module.exports = {
  createStore,
  resolveBackend,
};
