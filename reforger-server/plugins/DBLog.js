const logger = require("../logger/logger");

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
      await this.migrateToUTF8MB4();
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
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
      `;

    const connection = await process.mysqlPool.getConnection();
    await connection.query(createTableQuery);
    connection.release();
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

  async migrateToUTF8MB4() {
    try {
      // First query to check if the table is already utf8mb4
      const [result] = await process.mysqlPool.query(`
        SELECT TABLE_COLLATION 
        FROM information_schema.TABLES 
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'players'
      `);
      if (result.length > 0 && !result[0].TABLE_COLLATION.startsWith("utf8mb4")) {
        await process.mysqlPool.query(`
          ALTER TABLE players CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `);
        logger.info(`DBLog: Converted players table to utf8mb4`);
      }
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
    try {
      await this.batchProcessPlayers(players);
      logger.info(`[${this.name}] Processed ${players.length} players.`);
    } catch (error) {
      logger.error(`[${this.name}] Error processing players: ${error.message}`);
    }
  }

  // Create a new method which batches all updates to the database for all players instead of doing it one by one
  async batchProcessPlayers(players) {
    if (!Array.isArray(players) || players.length === 0) {
      return;
    }
    
    const playerUpdates = []; 
    const playerInserts = [];
    const playerUids = new Set();
    for (const player of players) {
      if (!player.uid) {
        continue;
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
          continue; // No changes, skip processing
        }
      }

      playerUids.add(player.uid);

      const updateFields = {};
      if (player.name) updateFields.playerName = player.name;
      if (player.ip) updateFields.playerIP = player.ip;
      if (player.beGUID) updateFields.beGUID = player.beGUID;
      if (player.steamID !== undefined) updateFields.steamID = player.steamID;
      if (player.device !== undefined) updateFields.device = player.device;

      if (Object.keys(updateFields).length > 0) {
        const setClause = Object.keys(updateFields)
          .map((field) => `${field} = ?`)
          .join(", ");
        const values = Object.values(updateFields);
        values.push(player.uid);
        playerUpdates.push({ setClause, values });
      } else {
        // If no fields to update, prepare for insert
        playerInserts.push({
          name: player.name || null,
          ip: player.ip || null,
          uid: player.uid,
          beGUID: player.beGUID || null,
          steamID: player.steamID !== undefined ? player.steamID : null,
          device: player.device || null,
        });
      }
    }
    if (playerUpdates.length === 0 && playerInserts.length === 0) {
      return; // No updates or inserts to process
    }
    const connection = await process.mysqlPool.getConnection();
    try {
      // Process updates
      for (const update of playerUpdates) {
        const updateQuery = `UPDATE players SET ${update.setClause} WHERE playerUID = ?`;
        await connection.query(updateQuery, update.values);
      }

      // Process inserts
      if (playerInserts.length > 0) {
        const insertQuery = `
          INSERT INTO players (playerName, playerIP, playerUID, beGUID, steamID, device, lastSeen)
          VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `;
        for (const player of playerInserts) {
          await connection.query(insertQuery, [
            player.name,
            player.ip,
            player.uid,
            player.beGUID,
            player.steamID,
            player.device,
          ]);
        }
      }

      // Update cache
      for (const uid of playerUids) {
        this.playerCache.set(uid, {
          name: players.find(p => p.uid === uid).name,
          ip: players.find(p => p.uid === uid).ip,
          beGUID: players.find(p => p.uid === uid).beGUID,
          steamID: players.find(p => p.uid === uid).steamID,
          device: players.find(p => p.uid === uid).device,
        });
      }

      // Set TTL for cache entries
      setTimeout(() => {
        for (const uid of playerUids) {
          this.playerCache.delete(uid);
        }
      }, this.cacheTTL);
    } catch (error) {
      logger.error(`Error processing batch of players: ${error.message}`);
    } finally {
      connection.release();
    }
  }

  // async processPlayer(player) {
  //   if (!player.uid) {
  //     return;
  //   }

  //   try {
  //     if (player.device === 'Console' && player.steamID) {
  //       logger.warn(`Unexpected: Console player ${player.name} has a steamID: ${player.steamID}. This shouldn't happen.`);
  //     }

  //     if (this.playerCache.has(player.uid)) {
  //       const cachedPlayer = this.playerCache.get(player.uid);

  //       if (
  //         cachedPlayer.name === player.name &&
  //         cachedPlayer.ip === player.ip &&
  //         cachedPlayer.beGUID === player.beGUID &&
  //         cachedPlayer.steamID === player.steamID &&
  //         cachedPlayer.device === player.device
  //       ) {
  //         return;
  //       }
  //     }

  //     const [rows] = await process.mysqlPool.query(
  //       "SELECT * FROM players WHERE playerUID = ?",
  //       [player.uid]
  //     );

  //     if (rows.length > 0) {
  //       const dbPlayer = rows[0];
  //       let needsUpdate = false;
  //       const updateFields = {};

  //       if (dbPlayer.playerName !== player.name) {
  //         updateFields.playerName = player.name || null;
  //         needsUpdate = true;
  //       }
  //       if (player.ip && dbPlayer.playerIP !== player.ip) {
  //         updateFields.playerIP = player.ip;
  //         needsUpdate = true;
  //       }
  //       if (player.beGUID && dbPlayer.beGUID !== player.beGUID) {
  //         updateFields.beGUID = player.beGUID;
  //         needsUpdate = true;
  //       }
  //       if (player.steamID !== undefined && dbPlayer.steamID !== player.steamID) {
  //         updateFields.steamID = player.steamID;
  //         needsUpdate = true;
  //       }
  //       if (player.device !== undefined && dbPlayer.device !== player.device) {
  //         updateFields.device = player.device;
  //         needsUpdate = true;
  //       }

  //       if (needsUpdate) {

  //         const setClause = Object.keys(updateFields)
  //           .map((field) => `${field} = ?`)
  //           .join(", ");
  //         const values = Object.values(updateFields);
  //         values.push(player.uid);

  //         const updateQuery = `UPDATE players SET ${setClause} WHERE playerUID = ?`;
  //         await process.mysqlPool.query(updateQuery, values);
  //       }
  //     } else {
  //       const insertQuery = `
  //         INSERT INTO players (playerName, playerIP, playerUID, beGUID, steamID, device, lastSeen)
  //         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  //       `;
  //       await process.mysqlPool.query(insertQuery, [
  //         player.name || null,
  //         player.ip || null,
  //         player.uid,
  //         player.beGUID || null,
  //         player.steamID !== undefined ? player.steamID : null,
  //         player.device || null,
  //       ]);
  //     }

  //     this.playerCache.set(player.uid, {
  //       name: player.name,
  //       ip: player.ip,
  //       beGUID: player.beGUID,
  //       steamID: player.steamID,
  //       device: player.device,
  //     });

  //     setTimeout(() => {
  //       this.playerCache.delete(player.uid);
  //     }, this.cacheTTL);
  //   } catch (error) {
  //     logger.error(`Error processing player ${player.name}: ${error.message}`);
  //   }
  // }

  // async handlePlayerJoined(player) {
  //   const eventTime = player?.time ? parseLogDate(player.time) : null;
  //   // If it's more than 5 seconds old, ignore it
  //   if (eventTime && isNaN(eventTime.getTime()) || Date.now() - eventTime.getTime() > 5000) {
  //     return;
  //   }

  //   if (!player.beGUID) {
  //     logger.warn(`[${this.name}] Player joined without a BE GUID: ${player.name}`);
  //     return;
  //   }

  //   // Set the lastSeen timestamp to the current timestamp
  //   const updateQuery = `UPDATE players SET lastSeen = CURRENT_TIMESTAMP WHERE beGUID = ?`;
  //   const connection = await process.mysqlPool.getConnection();
  //   await connection.query(updateQuery, [player.beGUID]);
  //   connection.release();
  // }


  async cleanup() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.playerCache.clear();
  }
}

module.exports = DBLog;