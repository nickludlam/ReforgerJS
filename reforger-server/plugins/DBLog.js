const mysql = require("mysql2/promise");

class DBLog {
  constructor(config) {
    this.config = config;
    this.name = "DBLog Plugin";
    this.interval = null;
    this.logIntervalMinutes = 5;
    this.isInitialized = false;
    this.serverInstance = null;
    this.playerCache = new Map();
    this.cacheTTL = 10 * 60 * 1000; 
  }

  async prepareToMount(serverInstance) {
    await this.cleanup();
    this.serverInstance = serverInstance;

    try {
      if (
        !this.config.connectors ||
        !this.config.connectors.mysql ||
        !this.config.connectors.mysql.enabled
      ) {
        return;
      }

      if (!process.mysqlPool) {
        return;
      }

      const pluginConfig = this.config.plugins.find(
        (plugin) => plugin.plugin === "DBLog"
      );
      if (
        pluginConfig &&
        typeof pluginConfig.interval === "number" &&
        pluginConfig.interval > 0
      ) {
        this.logIntervalMinutes = pluginConfig.interval;
      }

      await this.setupSchema();
      this.startLogging();
      this.isInitialized = true;
    } catch (error) {}
  }

  async setupSchema() {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS players (
        id INT AUTO_INCREMENT PRIMARY KEY,
        playerName VARCHAR(255) NULL,
        playerIP VARCHAR(255) NULL,
        playerUID VARCHAR(255) NOT NULL UNIQUE,
        beGUID VARCHAR(255) NULL,
        created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;

    try {
      const connection = await process.mysqlPool.getConnection();
      await connection.query(createTableQuery);
      connection.release();
    } catch (error) {
      throw error;
    }
  }

  startLogging() {
    const intervalMs = this.logIntervalMinutes * 60 * 1000;
    this.logPlayers();
    this.interval = setInterval(() => this.logPlayers(), intervalMs);
  }

  async logPlayers() {
    const players = this.serverInstance.players;

    if (!Array.isArray(players) || players.length === 0) {
      return;
    }

    for (const player of players) {
      await this.processPlayer(player);
    }
  }

  async processPlayer(player) {
    if (!player.uid) {
      return;
    }

    try {
      if (this.playerCache.has(player.uid)) {
        const cachedPlayer = this.playerCache.get(player.uid);

        if (
          cachedPlayer.name === player.name &&
          cachedPlayer.ip === player.ip &&
          cachedPlayer.beGUID === player.beGUID
        ) {
          return;
        }
      }

      const [rows] = await process.mysqlPool.query(
        "SELECT * FROM players WHERE playerUID = ?",
        [player.uid]
      );

      if (rows.length > 0) {
        const dbPlayer = rows[0];
        let needsUpdate = false;
        const updateFields = {};

        if (dbPlayer.playerName !== player.name) {
          updateFields.playerName = player.name || null;
          needsUpdate = true;
        }
        if (player.ip && dbPlayer.playerIP !== player.ip) {
          updateFields.playerIP = player.ip;
          needsUpdate = true;
        }
        if (player.beGUID && dbPlayer.beGUID !== player.beGUID) {
          updateFields.beGUID = player.beGUID;
          needsUpdate = true;
        }

        if (needsUpdate) {
          const setClause = Object.keys(updateFields)
            .map((field) => `${field} = ?`)
            .join(", ");
          const values = Object.values(updateFields);
          values.push(player.uid);

          const updateQuery = `UPDATE players SET ${setClause} WHERE playerUID = ?`;
          await process.mysqlPool.query(updateQuery, values);
        }
      } else {
        const insertQuery = `
          INSERT INTO players (playerName, playerIP, playerUID, beGUID)
          VALUES (?, ?, ?, ?)
        `;
        await process.mysqlPool.query(insertQuery, [
          player.name || null,
          player.ip || null,
          player.uid,
          player.beGUID || null,
        ]);
      }

      this.playerCache.set(player.uid, {
        name: player.name,
        ip: player.ip,
        beGUID: player.beGUID,
      });

      setTimeout(() => {
        this.playerCache.delete(player.uid);
      }, this.cacheTTL);
    } catch (error) {}
  }

  async cleanup() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.playerCache.clear();
  }
}

module.exports = DBLog;
