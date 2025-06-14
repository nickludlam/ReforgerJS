const logger = require("../logger/logger");

// Async-safe Queue implementation for player updates
class PlayerUpdateQueue {
  constructor(maxSize = 100) {
    this.queue = [];
    this.maxSize = maxSize;
    this.processing = false;
    this.lock = Promise.resolve(); // Used as a mutex lock
  }

  // Add item to the queue in a thread-safe way
  async enqueue(item) {
    // Wait for any ongoing operations to complete
    await this.lock;
    
    // Create a new lock
    let unlockNext;
    this.lock = new Promise(resolve => {
      unlockNext = resolve;
    });

    try {
      this.queue.push(item);
      return this.queue.length >= this.maxSize;
    } finally {
      // Release the lock
      unlockNext();
    }
  }

  // Get and remove all items from the queue
  async dequeueAll() {
    await this.lock;
    
    let unlockNext;
    this.lock = new Promise(resolve => {
      unlockNext = resolve;
    });

    try {
      const items = [...this.queue];
      this.queue = [];
      return items;
    } finally {
      unlockNext();
    }
  }

  // Check queue size
  async size() {
    await this.lock;
    return this.queue.length;
  }

  // Check if queue is full
  async isFull() {
    await this.lock;
    return this.queue.length >= this.maxSize;
  }

  // Check if queue is empty
  async isEmpty() {
    await this.lock;
    return this.queue.length === 0;
  }
}

class DBLog {
  constructor(config) {
    this.config = config;
    this.name = "DBLog Plugin";
    this.interval = null;
    this.logIntervalMinutes = 5;
    this.playerUpdateEventQueue = new PlayerUpdateQueue(100);
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
      if (pluginConfig) {
        // Check if interval is defined, is a number, and is positive
        if (
          pluginConfig.interval !== undefined &&
          typeof pluginConfig.interval === "number" &&
          pluginConfig.interval > 0
        ) {
          this.logIntervalMinutes = pluginConfig.interval;
          logger.verbose(`[${this.name}] Set log interval to ${this.logIntervalMinutes} minutes from config.`);
        } else {
          logger.verbose(`[${this.name}] Using default log interval of ${this.logIntervalMinutes} minutes.`);
        }
      }

      await this.setupSchema();
      await this.migrateSchema();
      await this.migrateToUTF8MB4();
      this.startLogging();

      // We also want to listen for playerUpdate events
      this.serverInstance.removeListener("playerUpdate", this.handlePlayerUpdate);
      this.serverInstance.on("playerUpdate", this.handlePlayerUpdate.bind(this));

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
    this.interval = setInterval(() => this.logPlayersOnInterval(), intervalMs);
    
    // Also periodically flush the queue even if not full
    // this.queueFlushInterval = setInterval(() => this.flushPlayerUpdateQueue(), 30000); // Every 30 seconds
  }
  
  async flushPlayerUpdateQueue() {
    try {
      if (!this.isInitialized) return;
      
      const isEmpty = await this.playerUpdateEventQueue.isEmpty();
      if (isEmpty) return;
      
      // logger.verbose(`[${this.name}] Flushing player update queue.`);
      const players = await this.playerUpdateEventQueue.dequeueAll();
      await this.batchProcessPlayers(players);
    } catch (error) {
      logger.error(`[${this.name}] Error flushing player update queue: ${error.message}`);
    }
  }

  async logPlayersOnInterval() {
    const players = this.serverInstance.players;
    try {
      await this.batchProcessPlayers(players);
    } catch (error) {
      logger.error(`[${this.name}] Error processing players: ${error.message}`);
    }
  }

  async handlePlayerUpdate(data) {
    if (!this.isInitialized || !data || !data.uid) {
      return;
    }

    try {
      // Add to the async-safe queue
      const isFull = await this.playerUpdateEventQueue.enqueue(data);
      
      if (isFull) {
        // If queue is full, process all items
        logger.info(`[${this.name}] Player update event queue reached max size. Processing batch.`);
        const players = await this.playerUpdateEventQueue.dequeueAll();
        await this.batchProcessPlayers(players);
      }
    } catch (error) {
      logger.error(`[${this.name}] Error handling player update: ${error.message}`);
    }
  }

  // Make a new method which does batch processing of players
  async batchProcessPlayers(players) {
    // Prepare the batch insert query with multiple value sets
    const baseSql = `
      INSERT INTO players (playerName, playerIP, playerUID, beGUID, steamID, device, lastSeen)
      VALUES 
    `;
    
    const connection = await process.mysqlPool.getConnection();
    // start a transaction
    try {
      const validPlayers = players.filter(player => player && player.uid);
      if (validPlayers.length === 0) {
        return;
      }
      
      await connection.beginTransaction();
      
      // Prepare values and parameters for the batch query
      const valuePlaceholders = [];
      const params = [];
      
      for (const player of validPlayers) {
        const timestamp = player.time ? new Date(player.time) : new Date();
        
        // Add one set of value placeholders for each player
        valuePlaceholders.push('(?, ?, ?, ?, ?, ?, ?)');
        
        // Add all parameters for this player
        params.push(
          player.name || null,
          player.ip || null,
          player.uid,
          player.beGUID || null,
          player.steamID !== undefined ? player.steamID : null,
          player.device || null,
          timestamp
        );
      }
      
      // Combine the base SQL with the placeholders and ON DUPLICATE KEY UPDATE clause
      // But also prevent empty values for beGUID and steamID when we have an existing value
      // Also, only update lastSeen if the new timestamp is greater than or equal to the existing one
      const fullSql = `
        ${baseSql} ${valuePlaceholders.join(', ')}
        ON DUPLICATE KEY UPDATE
          playerName = VALUES(playerName),
          playerIP = COALESCE(NULLIF(VALUES(playerIP), ''), playerIP),
          beGUID = COALESCE(NULLIF(VALUES(beGUID), ''), beGUID),
          steamID = COALESCE(NULLIF(VALUES(steamID), ''), steamID),
          device = COALESCE(NULLIF(VALUES(device), ''), device),
          lastSeen = IF(VALUES(lastSeen) >= lastSeen OR lastSeen IS NULL, VALUES(lastSeen), lastSeen)
      `;
      
      // Execute the batch query
      await connection.query(fullSql, params);
      await connection.commit();
      
      logger.info(`[${this.name}] Batch processed ${validPlayers.length} players.`);
    } catch (error) {
      logger.error(`Error batch processing players: ${error.message}`);
      // Rollback the transaction if there was an error
      try {
        await connection.rollback();
      } catch (rollbackError) {
        logger.error(`Error rolling back transaction: ${rollbackError.message}`);
      }
    } finally {
      connection.release();
    }
  }

  async cleanup() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    
    if (this.queueFlushInterval) {
      clearInterval(this.queueFlushInterval);
      this.queueFlushInterval = null;
    }
    
    // Flush any remaining items in the queue before cleanup
    try {
      const isEmpty = await this.playerUpdateEventQueue.isEmpty();
      if (!isEmpty) {
        logger.info(`[${this.name}] Flushing remaining items in queue during cleanup.`);
        const players = await this.playerUpdateEventQueue.dequeueAll();
        await this.batchProcessPlayers(players);
      }
    } catch (error) {
      logger.error(`[${this.name}] Error flushing queue during cleanup: ${error.message}`);
    }
    
    this.playerCache.clear();
  }
}

module.exports = DBLog;