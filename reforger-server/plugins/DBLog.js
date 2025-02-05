const mysql = require("mysql2/promise");

class DBLog {
  constructor(config) {
    this.config = config;
    this.name = "DBLog Plugin";
    this.interval = null;
    this.logIntervalMinutes = 5;
    this.isInitialized = false;
    this.serverInstance = null;
  }

  async prepareToMount(serverInstance) {
    logger.verbose(`[${this.name}] Preparing to mount...`);
    this.serverInstance = serverInstance;

    try {
      if (
        !this.config.connectors ||
        !this.config.connectors.mysql ||
        !this.config.connectors.mysql.enabled
      ) {
        logger.warn(
          `[${this.name}] MySQL is not enabled in the configuration. Plugin will be disabled.`
        );
        return;
      }

      if (!process.mysqlPool) {
        logger.error(
          `[${this.name}] MySQL pool is not available. Ensure MySQL is connected before enabling this plugin.`
        );
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
      logger.info(
        `[${this.name}] Initialized and started logging every ${this.logIntervalMinutes} minutes.`
      );
    } catch (error) {
      logger.error(
        `[${this.name}] Error during initialization: ${error.message}`
      );
    }
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
      logger.verbose(`[${this.name}] Database schema ensured.`);
    } catch (error) {
      logger.error(
        `[${this.name}] Failed to set up database schema: ${error.message}`
      );
      throw error;
    }
  }

  startLogging() {
    const intervalMs = this.logIntervalMinutes * 60 * 1000;
    this.logPlayers();
    this.interval = setInterval(() => this.logPlayers(), intervalMs);
    logger.verbose(`[${this.name}] Started logging every ${this.logIntervalMinutes} minutes.`);
  }

  async logPlayers() {
    logger.verbose(`[${this.name}] Initiating player log cycle.`);
    const players = this.serverInstance.players;

    if (!Array.isArray(players) || players.length === 0) {
      logger.warn(`[${this.name}] No players found to log.`);
      return;
    }

    for (const player of players) {
      await this.processPlayer(player);
    }

    logger.info(`[${this.name}] Player log cycle completed.`);
  }

  async processPlayer(player) {
    if (!player.uid) {
      logger.verbose(
        `[${this.name}] Skipping player '${player.name}' due to missing UID.`
      );
      return;
    }
  
    try {
      const [rows] = await process.mysqlPool.query(
        "SELECT * FROM players WHERE playerUID = ?",
        [player.uid]
      );
  
      if (rows.length > 0) {
        const dbPlayer = rows[0];
        let needsUpdate = false;
        const updateFields = {};
  
        // Check if playerName has changed
        if (dbPlayer.playerName !== player.name) {
          updateFields.playerName = player.name || null;
          needsUpdate = true;
        }
  
        // Check if playerIP has changed, but only update if `player.ip` is defined
        if (player.ip && dbPlayer.playerIP !== player.ip) {
          updateFields.playerIP = player.ip;
          needsUpdate = true;
        }
  
        // Check if beGUID has changed
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
        // Player does not exist, insert a new record
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
    } catch (error) {
      logger.error(
        `[${this.name}] Error processing player '${player.name}' (UID: ${player.uid}): ${error.message}`
      );
    }
  }

  async cleanup() {
    logger.verbose(`[${this.name}] Cleaning up...`);
    if (this.interval) {
      clearInterval(this.interval);
      logger.verbose(`[${this.name}] Cleared logging interval.`);
    }
    logger.info(`[${this.name}] Cleanup completed.`);
  }
}

module.exports = DBLog;
