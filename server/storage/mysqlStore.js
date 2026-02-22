const mysql = require('mysql2/promise');

const DEFAULT_PORT = 3306;
const DEFAULT_POOL_SIZE = 10;

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function stringifyJson(value) {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

function normalizeIso(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toISOString();
}

class MySQLStore {
  constructor() {
    this.host = process.env.DB_HOST || process.env.MYSQL_HOST || '127.0.0.1';
    this.port = Number(process.env.DB_PORT || process.env.MYSQL_PORT || DEFAULT_PORT);
    this.user = process.env.DB_USER || process.env.MYSQL_USER || 'vibe';
    this.password = process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || 'vibe_pass';
    this.database = process.env.DB_NAME || process.env.MYSQL_DATABASE || 'vibe_board';
    this.createDatabase = String(process.env.DB_CREATE_IF_NOT_EXISTS || '1') !== '0';
    this.pool = null;
  }

  async init() {
    if (this.pool) return;

    if (this.createDatabase) {
      const bootstrap = await mysql.createConnection({
        host: this.host,
        port: this.port,
        user: this.user,
        password: this.password,
      });
      try {
        await bootstrap.query(
          `CREATE DATABASE IF NOT EXISTS \`${this.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
        );
      } finally {
        await bootstrap.end();
      }
    }

    this.pool = mysql.createPool({
      host: this.host,
      port: this.port,
      user: this.user,
      password: this.password,
      database: this.database,
      waitForConnections: true,
      connectionLimit: Number(process.env.DB_POOL_SIZE || DEFAULT_POOL_SIZE),
      queueLimit: 0,
    });

    await this.ensureSchema();
  }

  async ensureSchema() {
    const conn = await this.pool.getConnection();
    try {
      await conn.query(`
        CREATE TABLE IF NOT EXISTS machines (
          id VARCHAR(191) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          display_name VARCHAR(255) NULL,
          fingerprint VARCHAR(255) NOT NULL,
          aliases_json LONGTEXT NOT NULL,
          last_seen VARCHAR(40) NOT NULL,
          online_since VARCHAR(40) NULL,
          updated_at VARCHAR(40) NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      await conn.query(`
        CREATE TABLE IF NOT EXISTS tasks (
          machine_id VARCHAR(191) NOT NULL,
          id VARCHAR(191) NOT NULL,
          title TEXT NOT NULL,
          status VARCHAR(64) NOT NULL,
          source VARCHAR(64) NULL,
          created_at VARCHAR(40) NOT NULL,
          updated_at VARCHAR(40) NOT NULL,
          preview_images_json LONGTEXT NULL,
          PRIMARY KEY (machine_id, id),
          KEY idx_tasks_machine_id (machine_id),
          KEY idx_tasks_id (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      const [sourceColumns] = await conn.query("SHOW COLUMNS FROM tasks LIKE 'source'");
      if (!Array.isArray(sourceColumns) || sourceColumns.length === 0) {
        await conn.query('ALTER TABLE tasks ADD COLUMN source VARCHAR(64) NULL AFTER status');
      }

      await conn.query(`
        CREATE TABLE IF NOT EXISTS history (
          id VARCHAR(255) PRIMARY KEY,
          event VARCHAR(64) NOT NULL,
          machine_id VARCHAR(191) NOT NULL,
          task_id VARCHAR(191) NOT NULL,
          title TEXT NULL,
          from_status VARCHAR(64) NULL,
          to_status VARCHAR(64) NULL,
          changed_at VARCHAR(40) NOT NULL,
          created_at VARCHAR(40) NOT NULL,
          KEY idx_history_machine_task (machine_id, task_id),
          KEY idx_history_changed_at (changed_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    } finally {
      conn.release();
    }
  }

  async loadDB() {
    await this.init();
    const conn = await this.pool.getConnection();
    try {
      const [machineRows] = await conn.query(
        'SELECT id, name, display_name, fingerprint, aliases_json, last_seen, online_since FROM machines'
      );
      const [taskRows] = await conn.query(
        'SELECT machine_id, id, title, status, source, created_at, updated_at, preview_images_json FROM tasks'
      );
      const [historyRows] = await conn.query(
        'SELECT id, event, machine_id, task_id, title, from_status, to_status, changed_at FROM history'
      );

      const machines = machineRows.map((row) => ({
        id: row.id,
        name: row.name,
        display_name: row.display_name || undefined,
        fingerprint: row.fingerprint,
        aliases: parseJsonArray(row.aliases_json),
        last_seen: normalizeIso(row.last_seen) || row.last_seen,
        online_since: normalizeIso(row.online_since) || row.online_since || undefined,
      }));

      const tasks = taskRows.map((row) => {
        const task = {
          machine_id: row.machine_id,
          id: row.id,
          title: row.title,
          status: row.status,
          created_at: normalizeIso(row.created_at) || row.created_at,
          updated_at: normalizeIso(row.updated_at) || row.updated_at,
        };
        if (row.source) {
          task.source = row.source;
        }
        const previewImages = parseJsonArray(row.preview_images_json);
        if (previewImages.length > 0) {
          task.preview_images = previewImages;
        }
        return task;
      });

      const history = historyRows.map((row) => ({
        id: row.id,
        event: row.event,
        machine_id: row.machine_id,
        task_id: row.task_id,
        title: row.title,
        from_status: row.from_status,
        to_status: row.to_status,
        changed_at: normalizeIso(row.changed_at) || row.changed_at,
      }));

      return { machines, tasks, history };
    } finally {
      conn.release();
    }
  }

  async saveDB(db) {
    await this.init();
    const machines = Array.isArray(db?.machines) ? db.machines : [];
    const tasks = Array.isArray(db?.tasks) ? db.tasks : [];
    const history = Array.isArray(db?.history) ? db.history : [];
    const now = new Date().toISOString();

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      await conn.query('DELETE FROM history');
      await conn.query('DELETE FROM tasks');
      await conn.query('DELETE FROM machines');

      for (const machine of machines) {
        if (!machine?.id) continue;
        await conn.execute(
          `INSERT INTO machines (id, name, display_name, fingerprint, aliases_json, last_seen, online_since, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            machine.id,
            machine.name || machine.id,
            machine.display_name || null,
            machine.fingerprint || machine.id,
            stringifyJson(machine.aliases || []),
            normalizeIso(machine.last_seen) || now,
            normalizeIso(machine.online_since) || null,
            now,
          ]
        );
      }

      for (const task of tasks) {
        if (!task?.id || !task?.machine_id) continue;
        const previewImages = Array.isArray(task.preview_images) ? task.preview_images : [];
        await conn.execute(
          `INSERT INTO tasks (machine_id, id, title, status, source, created_at, updated_at, preview_images_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            task.machine_id,
            task.id,
            task.title || 'Untitled Task',
            task.status || 'in_progress',
            task.source || null,
            normalizeIso(task.created_at) || now,
            normalizeIso(task.updated_at) || now,
            previewImages.length > 0 ? stringifyJson(previewImages) : null,
          ]
        );
      }

      for (const item of history) {
        if (!item?.id) continue;
        await conn.execute(
          `INSERT INTO history (id, event, machine_id, task_id, title, from_status, to_status, changed_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            item.id,
            item.event || 'status_changed',
            item.machine_id || '',
            item.task_id || '',
            item.title || null,
            item.from_status || null,
            item.to_status || null,
            normalizeIso(item.changed_at) || now,
            now,
          ]
        );
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }
}

module.exports = {
  MySQLStore,
};
