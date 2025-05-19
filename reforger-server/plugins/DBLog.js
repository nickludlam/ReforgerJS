const mysql = require("mysql2/promise");
const logger = require("../logger/logger");
const { parseLogDate } = require("../../helpers");

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
    logger.verbose(`[${this.name}] Preparing to mount...`);
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
      await this.migrateSchema();
      this.startLogging();

      // We also want to listen for playerJoined and playerLeft events
      this.serverInstance.removeListener("playerJoined", this.handlePlayerJoined);
      this.serverInstance.on("playerJoined", this.handlePlayerJoined.bind(this));

      this.isInitialized = true;
      logger.info(`[${this.name}] Initialized: Listening to playerJoined events and logging players every ${this.logIntervalMinutes} minutes.`);
    } catch (error) {
      if (serverInstance.logger) {
        logger.error(`Error initializing DBLog: ${error.message}`);
      }
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
        steamID VARCHAR(255) NULL,
        device VARCHAR(50) NULL,
        lastSeen TIMESTAMP NULL
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

  async migrateSchema() {
    try {
      const connection = await process.mysqlPool.getConnection();
      
      const [columns] = await connection.query(`
        SELECT COLUMN_NAME 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'players'
      `);
      
      const columnNames = columns.map(col => col.COLUMN_NAME);
      const alterQueries = [];
      
      if (!columnNames.includes('steamID')) {
        alterQueries.push('ADD COLUMN steamID VARCHAR(255) NULL');
      }
      
      if (!columnNames.includes('device')) {
        alterQueries.push('ADD COLUMN device VARCHAR(50) NULL');
      }
      
      // Add an updated datetime column if it doesn't exist
      if (!columnNames.includes('lastSeen')) {
        alterQueries.push('ADD COLUMN lastSeen TIMESTAMP NULL');
      }
      
      if (alterQueries.length > 0) {
        const alterQuery = `ALTER TABLE players ${alterQueries.join(', ')}`;
        await connection.query(alterQuery);
        
        logger.info(`DBLog: Migrated players table with new columns: ${alterQueries.join(', ')}`);
      }

      // Also check the keys
      const [indexes] = await connection.query(`
        SELECT INDEX_NAME
        FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'players'
        AND COLUMN_NAME = 'beGUID'
        AND NON_UNIQUE = 0
      `);

      // If there is no key on beGUID, add it
      if (indexes.length === 0) {
        await connection.query(`
          ALTER TABLE players ADD UNIQUE INDEX beGUID (beGUID)
        `);
        logger.info(`Added index on beGUID to players`);
      }
      
      connection.release();
    } catch (error) {
      logger.error(`Error migrating schema: ${error.message}`);
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
      if (player.device === 'Console' && player.steamID) {
        logger.warn(`Unexpected: Console player ${player.name} has a steamID: ${player.steamID}. This shouldn't happen.`);
      }

      if (this.playerCache.has(player.uid)) {
        const cachedPlayer = this.playerCache.get(player.uid);

        if (
          cachedPlayer.name === player.name &&
          cachedPlayer.ip === player.ip &&
          cachedPlayer.beGUID === player.beGUID &&
          cachedPlayer.steamID === player.steamID &&
          cachedPlayer.device === player.device
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
        if (player.steamID !== undefined && dbPlayer.steamID !== player.steamID) {
          updateFields.steamID = player.steamID;
          needsUpdate = true;
        }
        if (player.device !== undefined && dbPlayer.device !== player.device) {
          updateFields.device = player.device;
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
          INSERT INTO players (playerName, playerIP, playerUID, beGUID, steamID, device, lastSeen)
          VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `;
        await process.mysqlPool.query(insertQuery, [
          player.name || null,
          player.ip || null,
          player.uid,
          player.beGUID || null,
          player.steamID !== undefined ? player.steamID : null,
          player.device || null,
        ]);
      }

      this.playerCache.set(player.uid, {
        name: player.name,
        ip: player.ip,
        beGUID: player.beGUID,
        steamID: player.steamID,
        device: player.device,
      });

      setTimeout(() => {
        this.playerCache.delete(player.uid);
      }, this.cacheTTL);
    } catch (error) {
      logger.error(`Error processing player ${player.name}: ${error.message}`);
    }
  }

  async handlePlayerJoined(player) {
    const eventTime = player?.time ? parseLogDate(player.time) : null;
    // If it's more than 5 seconds old, ignore it
    if (eventTime && isNaN(eventTime.getTime()) || Date.now() - eventTime.getTime() > 5000) {
      return;
    }

    if (!player.beGUID) {
      logger.warn(`[${this.name}] Player joined without a BE GUID: ${player.name}`);
      return;
    }

    // Set the lastSeen timestamp to the current timestamp
    const updateQuery = `UPDATE players SET lastSeen = CURRENT_TIMESTAMP WHERE beGUID = ?`;
    const connection = await process.mysqlPool.getConnection();
    await connection.query(updateQuery, [player.beGUID]);
    connection.release();
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