const { EventEmitter } = require('events');
const fs = require("fs").promises;
const pathModule = require("path");
const logger = require("../logger/logger");

class DBLogStats extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.name = "DBLogStats Plugin";
    this.emittedEvents = ['playerStatsUpdated'];
    this.interval = null;
    this.logIntervalMinutes = 15; // default interval (minutes)
    this.serverInstance = null;
    this.folderPath = null;
    this.tableName = null;
    this.serverName = null;
    this.statFileMTimes = new Map();
  }

  async prepareToMount(serverInstance) {
    logger.verbose(`[${this.name}] Preparing to mount...`);
    this.serverInstance = serverInstance;

    try {
      // Check if MySQL connector is enabled
      if (
        !this.config.connectors ||
        !this.config.connectors.mysql ||
        !this.config.connectors.mysql.enabled
      ) {
        logger.warn(`[${this.name}] MySQL is not enabled in the configuration. Plugin will be disabled.`);
        return;
      }
      if (!process.mysqlPool) {
        logger.error(`[${this.name}] MySQL pool is not available. Ensure MySQL is connected before enabling this plugin.`);
        return;
      }

      // Retrieve plugin configuration
      const pluginConfig = this.config.plugins.find(plugin => plugin.plugin === "DBLogStats");
      if (!pluginConfig) {
        logger.warn(`[${this.name}] Plugin configuration not found. Plugin disabled.`);
        return;
      }

      // Use configured interval if provided
      if (typeof pluginConfig.interval === "number" && pluginConfig.interval > 0) {
        this.logIntervalMinutes = pluginConfig.interval;
      }

      // Check and set the folder path
      if (!pluginConfig.path) {
        logger.warn(`[${this.name}] 'path' not specified in config. Plugin disabled.`);
        return;
      }
      this.folderPath = pluginConfig.path;
      try {
        await fs.access(this.folderPath);
      } catch (err) {
        logger.error(`[${this.name}] Folder path '${this.folderPath}' not found. Plugin disabled: (${err.message})`);
        return;
      }

      // Get the table name from config
      if (!pluginConfig.tableName) {
        logger.warn(`[${this.name}] 'tableName' not specified in config. Plugin disabled.`);
        return;
      }
      this.tableName = pluginConfig.tableName;

      // Get the server name from config
      if (!pluginConfig.serverName || pluginConfig.serverName === "") {
        logger.info(`[${this.name}] 'serverName' not specified in config. Multi-server stats will not be available.`);
      }
      this.serverName = pluginConfig.serverName;

      // Create/ensure database schema
      await this.setupSchema();
      await this.migrateSchema();

      // Start the logging interval
      this.startLogging();
      logger.info(`[${this.name}] Initialized and started logging stats every ${this.logIntervalMinutes} minutes.`);
    } catch (error) {
      logger.error(`[${this.name}] Error during initialization: ${error.message}`);
    }
  }

  async setupSchema() {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS \`${this.tableName}\` (
        id INT AUTO_INCREMENT PRIMARY KEY,
        playerUID VARCHAR(255) NOT NULL,
        server_name VARCHAR(255) NULL,
        level FLOAT DEFAULT 0,
        level_experience FLOAT DEFAULT 0,
        session_duration FLOAT DEFAULT 0,
        sppointss0 FLOAT DEFAULT 0,
        sppointss1 FLOAT DEFAULT 0,
        sppointss2 FLOAT DEFAULT 0,
        warcrimes FLOAT DEFAULT 0,
        distance_walked FLOAT DEFAULT 0,
        kills FLOAT DEFAULT 0,
        ai_kills FLOAT DEFAULT 0,
        shots FLOAT DEFAULT 0,
        grenades_thrown FLOAT DEFAULT 0,
        friendly_kills FLOAT DEFAULT 0,
        friendly_ai_kills FLOAT DEFAULT 0,
        deaths FLOAT DEFAULT 0,
        distance_driven FLOAT DEFAULT 0,
        points_as_driver_of_players FLOAT DEFAULT 0,
        players_died_in_vehicle FLOAT DEFAULT 0,
        roadkills FLOAT DEFAULT 0,
        friendly_roadkills FLOAT DEFAULT 0,
        ai_roadkills FLOAT DEFAULT 0,
        friendly_ai_roadkills FLOAT DEFAULT 0,
        distance_as_occupant FLOAT DEFAULT 0,
        bandage_self FLOAT DEFAULT 0,
        bandage_friendlies FLOAT DEFAULT 0,
        tourniquet_self FLOAT DEFAULT 0,
        tourniquet_friendlies FLOAT DEFAULT 0,
        saline_self FLOAT DEFAULT 0,
        saline_friendlies FLOAT DEFAULT 0,
        morphine_self FLOAT DEFAULT 0,
        morphine_friendlies FLOAT DEFAULT 0,
        warcrime_harming_friendlies FLOAT DEFAULT 0,
        crime_acceleration FLOAT DEFAULT 0,
        kick_session_duration FLOAT DEFAULT 0,
        kick_streak FLOAT DEFAULT 0,
        lightban_session_duration FLOAT DEFAULT 0,
        lightban_streak FLOAT DEFAULT 0,
        heavyban_kick_session_duration FLOAT DEFAULT 0,
        heavyban_streak FLOAT DEFAULT 0,
        created TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY playerUID_server_name (playerUID, server_name),
        KEY idx_playerUID (playerUID),
        KEY idx_server_name (server_name)
      ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    `;
    try {
      // Use executeWithRetry for better handling of potential connection issues
      await this.executeWithRetry(async (connection) => {
        await connection.query(createTableQuery);
        logger.verbose(`[${this.name}] Database schema ensured for table '${this.tableName}'.`);
        return true;
      });
    } catch (error) {
      logger.error(`[${this.name}] Failed to set up database schema: ${error.message}`);
      throw error;
    }
  }

  async migrateSchema() {
    let connection;
    try {
      const alterQueries = [];
      connection = await process.mysqlPool.getConnection();
      
      // Check existing columns
      const [columns] = await connection.query(`
        SELECT COLUMN_NAME 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = '${this.tableName}'
      `);
      
      const columnNames = columns.map(col => col.COLUMN_NAME);
      
      // For multi-server support, we need to add server_name column
      if (!columnNames.includes('server_name')) {
        alterQueries.push('ADD COLUMN server_name VARCHAR(255) NULL');
      }

      // Check for new stats columns and add them if they don't exist - see SCR_PlayerData.c
      if (!columnNames.includes('lightban_session_duration')) {
        alterQueries.push('ADD COLUMN lightban_session_duration FLOAT DEFAULT 0');
      }
      if (!columnNames.includes('lightban_streak')) {
        alterQueries.push('ADD COLUMN lightban_streak FLOAT DEFAULT 0');
      }
      if (!columnNames.includes('heavyban_kick_session_duration')) {
        alterQueries.push('ADD COLUMN heavyban_kick_session_duration FLOAT DEFAULT 0');
      }
      if (!columnNames.includes('heavyban_streak')) {
        alterQueries.push('ADD COLUMN heavyban_streak FLOAT DEFAULT 0');
      }

      // Check for existing indexes and update them properly
      const [indexes] = await connection.query(`
        SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE
        FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = '${this.tableName}'
      `);
      
      // Group indexes by name for easier processing
      const indexMap = {};
      indexes.forEach(idx => {
        if (!indexMap[idx.INDEX_NAME]) {
          indexMap[idx.INDEX_NAME] = {
            name: idx.INDEX_NAME,
            columns: [],
            nonUnique: idx.NON_UNIQUE === 1
          };
        }
        indexMap[idx.INDEX_NAME].columns.push(idx.COLUMN_NAME);
      });
      
      // Check for the unique constraint on playerUID and update it if needed
      if (indexMap.playerUID && indexMap.playerUID.columns.length === 1 && 
          indexMap.playerUID.columns[0] === 'playerUID' && !indexMap.playerUID.nonUnique) {
        logger.verbose(`[${this.name}] Found unique constraint on playerUID, updating to composite key`);
        alterQueries.push('DROP INDEX playerUID');
        
        // Only add the composite index if it doesn't exist
        if (!indexMap.playerUID_server_name) {
          alterQueries.push('ADD UNIQUE INDEX playerUID_server_name (playerUID, server_name)');
        }
      }
      
      // Add individual indexes for performance if they don't exist
      if (!indexMap.idx_playerUID && !indexMap.PRIMARY && !indexMap.playerUID) {
        alterQueries.push('ADD INDEX idx_playerUID (playerUID)');
      }
      
      // Only add server_name index if it doesn't already exist in any form
      const hasServerNameIndex = Object.values(indexMap).some(index => 
        index.columns.includes('server_name') && index.name !== 'playerUID_server_name'
      );
      
      if (!hasServerNameIndex && !indexMap.idx_server_name && columnNames.includes('server_name')) {
        alterQueries.push('ADD INDEX idx_server_name (server_name)');
      }
      
      // Check if table is using the correct character set and collation
      const [tableInfo] = await connection.query(`
        SELECT TABLE_COLLATION
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = '${this.tableName}'
      `);
      
      if (tableInfo.length > 0 && !tableInfo[0].TABLE_COLLATION.startsWith('utf8mb4')) {
        alterQueries.push('CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
        logger.info(`[${this.name}] Converting table to utf8mb4 character set`);
      }
      
      // Apply alterations in smaller batches to reduce lock time
      if (alterQueries.length > 0) {
        logger.verbose(`[${this.name}] Applying ${alterQueries.length} schema changes to table '${this.tableName}'`);
        
        // Execute alterations in smaller batches to reduce lock time
        for (let i = 0; i < alterQueries.length; i += 2) {
          const batchQueries = alterQueries.slice(i, i + 2);
          const alterQuery = `ALTER TABLE ${this.tableName} ${batchQueries.join(', ')}`;
          
          try {
            await connection.query(alterQuery);
            logger.verbose(`[${this.name}] Applied schema changes: ${batchQueries.join(', ')}`);
          } catch (alterError) {
            // Check for specific errors that can be safely ignored
            if (alterError.code === 'ER_DUP_KEYNAME') {
              logger.verbose(`[${this.name}] Index already exists, skipping: ${alterError.message}`);
            } else if (alterError.code === 'ER_CANT_DROP_FIELD_OR_KEY' && alterError.message.includes("check that column/key exists")) {
              logger.verbose(`[${this.name}] Index to drop doesn't exist, skipping: ${alterError.message}`);
            } else {
              // Log the error but continue with other alterations
              logger.error(`[${this.name}] Error applying alteration: ${alterError.message} (Code: ${alterError.code || 'unknown'})`);
            }
          }
        }
        
        if (this.serverInstance.logger) {
          this.serverInstance.logger.info(`DBLog: Migrated stats table with changes: ${alterQueries.join(', ')}`);
        }
      } else {
        if (this.serverInstance.logger) {
          this.serverInstance.logger.info(`DBLog: No migration needed for stats table.`);
        }
      }
    } catch (error) {
      if (this.serverInstance.logger) {
        this.serverInstance.logger.error(`Error migrating schema: ${error.message}`);
      }
      logger.error(`[${this.name}] Error during schema migration: ${error.message}`);
      throw error;
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }

  startLogging() {
    const intervalMs = this.logIntervalMinutes * 60 * 1000;
    // Run immediately, then on each interval.
    this.logStats();
    this.interval = setInterval(() => this.logStats(), intervalMs);
    logger.verbose(`[${this.name}] Started logging every ${this.logIntervalMinutes} minutes.`);
  }

  async logStats() {
    const playerStatsHash = await this.collectStats();
    if (!playerStatsHash || Object.keys(playerStatsHash).length === 0) {
      logger.verbose(`[${this.name}] No player stats to log.`);
      return;
    }

    logger.verbose(`[${this.name}] Logging stats for ${Object.keys(playerStatsHash).length} players.`);
    let totalAffectedRows = 0;
    const totalPlayers = Object.keys(playerStatsHash).length;
    
    const columns = [
      'playerUID', 'server_name', 'level', 'level_experience', 'session_duration', 
      'sppointss0', 'sppointss1', 'sppointss2', 'warcrimes', 'distance_walked', 
      'kills', 'ai_kills', 'shots', 'grenades_thrown', 'friendly_kills', 
      'friendly_ai_kills', 'deaths', 'distance_driven', 'points_as_driver_of_players', 
      'players_died_in_vehicle', 'roadkills', 'friendly_roadkills', 'ai_roadkills', 
      'friendly_ai_roadkills', 'distance_as_occupant', 'bandage_self', 
      'bandage_friendlies', 'tourniquet_self', 'tourniquet_friendlies', 
      'saline_self', 'saline_friendlies', 'morphine_self', 'morphine_friendlies', 
      'warcrime_harming_friendlies', 'crime_acceleration', 'kick_session_duration', 
      'kick_streak', 'lightban_session_duration', 'lightban_streak', 
      'heavyban_kick_session_duration', 'heavyban_streak'
    ];

    const updateStatements = columns
      .filter(col => col !== 'playerUID' && col !== 'server_name')
      .map(col => `${col} = VALUES(${col})`)
      .join(', ');

    // Smaller batch size to reduce deadlock probability
    const BATCH_SIZE = 250;
    const playerEntries = Object.entries(playerStatsHash);
    
    // Add random jitter to help avoid deadlocks between multiple servers
    const jitter = Math.floor(Math.random() * 1000);
    await new Promise(resolve => setTimeout(resolve, jitter));
    
    for (let i = 0; i < playerEntries.length; i += BATCH_SIZE) {
      const batch = playerEntries.slice(i, i + BATCH_SIZE);
      const values = [];
      const placeholders = [];
      
      for (const [playerUID, stats] of batch) {
        placeholders.push(`(${Array(columns.length).fill('?').join(', ')})`);
        values.push(
          playerUID,
          this.serverName || null,
          stats.level || 0,
          stats.level_experience || 0,
          stats.session_duration || 0,
          stats.sppointss0 || 0,
          stats.sppointss1 || 0,
          stats.sppointss2 || 0,
          stats.warcrimes || 0,
          stats.distance_walked || 0,
          stats.kills || 0,
          stats.ai_kills || 0,
          stats.shots || 0,
          stats.grenades_thrown || 0,
          stats.friendly_kills || 0,
          stats.friendly_ai_kills || 0,
          stats.deaths || 0,
          stats.distance_driven || 0,
          stats.points_as_driver_of_players || 0,
          stats.players_died_in_vehicle || 0,
          stats.roadkills || 0,
          stats.friendly_roadkills || 0,
          stats.ai_roadkills || 0,
          stats.friendly_ai_roadkills || 0,
          stats.distance_as_occupant || 0,
          stats.bandage_self || 0,
          stats.bandage_friendlies || 0,
          stats.tourniquet_self || 0,
          stats.tourniquet_friendlies || 0,
          stats.saline_self || 0,
          stats.saline_friendlies || 0,
          stats.morphine_self || 0,
          stats.morphine_friendlies || 0,
          stats.warcrime_harming_friendlies || 0,
          stats.crime_acceleration || 0,
          stats.kick_session_duration || 0,
          stats.kick_streak || 0,
          stats.lightban_session_duration || 0,
          stats.lightban_streak || 0,
          stats.heavyban_kick_session_duration || 0,
          stats.heavyban_streak || 0
        );
      }
      
      const query = `
        INSERT INTO ${this.tableName} (${columns.join(', ')})
        VALUES ${placeholders.join(', ')}
        ON DUPLICATE KEY UPDATE ${updateStatements}
      `;

      try {
        // Use executeWithRetry to handle transactions and deadlocks
        const affectedRows = await this.executeWithRetry(async (connection) => {
          // Execute the query within the transaction
          await connection.execute(query, values);
          
          // Get affected rows
          const [result] = await connection.query(`SELECT ROW_COUNT() AS affectedRows`);
          return result && result[0] && result[0].affectedRows ? result[0].affectedRows : 0;
        });
        
        // Update total affected rows
        totalAffectedRows += affectedRows;
        
      } catch (error) {
        // If all retries failed in executeWithRetry, log the error and continue with next batch
        logger.error(`[${this.name}] Failed to process batch after multiple retry attempts: ${error.message}`);
      }
      
      // Add a small delay between batches to reduce contention
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Check if the batch was logged successfully
    if (totalAffectedRows < totalPlayers) {
      logger.error(`[${this.name}] Not all player stats were logged successfully. Expected: ${totalPlayers}, Logged: ${totalAffectedRows}`);
    } else {
      logger.verbose(`[${this.name}] Successfully logged batch of ${totalPlayers} player stats.`);
    }

    this.emitEvent("playerStatsUpdated");
    return true;
  }

  async collectStats() {
    logger.verbose(`[${this.name}] Initiating stats logging cycle.`);

    // accumulate player stats as a dict mapping playerUID to stats
    const playerStatData = {};
    let skippedFileCount = 0;

    try {
      const files = await fs.readdir(this.folderPath);
      const statFiles = files.filter(file => /^PlayerData\..+\.json$/.test(file));
      if (statFiles.length === 0) {
        logger.verbose(`[${this.name}] No player stat files found in folder.`);
        return;
      }

      // Process files sequentially
      for (const file of statFiles) {
        const match = /^PlayerData\.(.+)\.json$/.exec(file);
        if (!match) continue;

        // Get the file mtime and check if we already processed it
        const filePath = pathModule.join(this.folderPath, file);
        const fileStat = await fs.stat(filePath);
        const fileMTime = fileStat.mtimeMs;
        if (this.statFileMTimes.has(file) && this.statFileMTimes.get(file) >= fileMTime) {
          skippedFileCount++;
          continue;
        } else {
          this.statFileMTimes.set(file, fileMTime);
        }

        const playerUID = match[1];
        let fileContent;
        try {
          fileContent = await fs.readFile(filePath, "utf8");
        } catch (readError) {
          logger.warn(`[${this.name}] Failed to read file ${file}: ${readError.message}`);
          continue;
        }
        let jsonData;
        try {
          jsonData = JSON.parse(fileContent);
        } catch (parseError) {
          logger.warn(`[${this.name}] Invalid JSON in file ${file}: ${parseError.message}`);
          continue;
        }
        if (!jsonData.m_aStats || !Array.isArray(jsonData.m_aStats)) {
          logger.warn(`[${this.name}] Missing or invalid 'm_aStats' in file ${file}.`);
          continue;
        }
        const stats = jsonData.m_aStats;
        if (stats.length < 35) {
          logger.warn(`[${this.name}] Not enough stat entries in file ${file}. Expected at least 35, got ${stats.length}.`);
          continue;
        }
        const trimmedStats = stats.slice(0, 39);
        const [
          level,                          // 0 - Rank of the player
          level_experience,               // 1 - XP points
          session_duration,               // 2 - Total duration of sessions
          sppointss0,                     // 3 - INFANTRY POINTS
          sppointss1,                     // 4 - LOGISTICS POINTS
          sppointss2,                     // 5 - MEDICAL POINTS
          warcrimes,                      // 6
          distance_walked,                // 7
          kills,                          // 8
          ai_kills,                       // 9
          shots,                          // 10
          grenades_thrown,                // 11
          friendly_kills,                 // 12
          friendly_ai_kills,              // 13
          deaths,                         // 14
          distance_driven,                // 15
          points_as_driver_of_players,    // 16
          players_died_in_vehicle,        // 17
          roadkills,                      // 18
          friendly_roadkills,             // 19
          ai_roadkills,                   // 20
          friendly_ai_roadkills,          // 21
          distance_as_occupant,           // 22
          bandage_self,                   // 23
          bandage_friendlies,             // 24
          tourniquet_self,                // 25
          tourniquet_friendlies,          // 26
          saline_self,                    // 27
          saline_friendlies,              // 28
          morphine_self,                  // 29
          morphine_friendlies,            // 30
          warcrime_harming_friendlies,    // 31 - Warcrime points
          crime_acceleration,             // 32 - Kick & Ban acceleration
          kick_session_duration,          // 33 - Session duration at the time player was kicked the last time
          kick_streak,                    // 34 - How many times was the player kicked in a row after last kick in a short succession
          lightban_session_duration,      // 35 - Session duration at the time player was lightbanned the last time
          lightban_streak,                // 36 - How many times was the player lightbanned in a row after the last lightban in a short succession
          heavyban_kick_session_duration, // 37 - Session duration at the time player was heavybanned the last time
          heavyban_streak                 // 38 - How many times was the player heavybanned in a row after the last heavyban in a short succession
        ] = trimmedStats;

        // Now place all these stats into the playerStatData dict keyed by playerUID
        playerStatData[playerUID] = {
          level,
          level_experience,
          session_duration,
          sppointss0,
          sppointss1,
          sppointss2,
          warcrimes,
          distance_walked,
          kills,
          ai_kills,
          shots,
          grenades_thrown,
          friendly_kills,
          friendly_ai_kills,
          deaths,
          distance_driven,
          points_as_driver_of_players,
          players_died_in_vehicle,
          roadkills,
          friendly_roadkills,
          ai_roadkills,
          friendly_ai_roadkills,
          distance_as_occupant,
          bandage_self,
          bandage_friendlies,
          tourniquet_self,
          tourniquet_friendlies,
          saline_self,
          saline_friendlies,
          morphine_self,
          morphine_friendlies,
          warcrime_harming_friendlies,
          crime_acceleration,
          kick_session_duration,
          kick_streak,
          lightban_session_duration,
          lightban_streak,
          heavyban_kick_session_duration,
          heavyban_streak
        };
      }
    } catch (error) {
      logger.error(`[${this.name}] Error during stats logging: ${error.message}`);
      return;
    }

    if (skippedFileCount > 0) {
      logger.verbose(`[${this.name}] Skipped ${skippedFileCount} files that were not updated since last scan.`);
    }

    logger.verbose(`[${this.name}] Collected stats for ${Object.keys(playerStatData).length} players.`);
    return playerStatData;
  }

  emitEvent(eventName, data = null) {
    logger.verbose(`[${this.name}] Emitting event: ${eventName}`);
    // check if the event name is valid
    if (!this.emittedEvents.includes(eventName)) {
      logger.warn(`[${this.name}] Invalid event name: ${eventName}`);
      return;
    }
    this.emit(eventName, data);
  }

  async cleanup() {
    logger.verbose(`[${this.name}] Cleaning up...`);
    if (this.interval) {
      clearInterval(this.interval);
      logger.verbose(`[${this.name}] Cleared logging interval.`);
    }
    logger.info(`[${this.name}] Cleanup completed.`);
  }

  async executeWithRetry(callback, maxRetries = 5) {
    let retries = maxRetries;
    let lastError = null;
    
    while (retries > 0) {
      let connection;
      try {
        connection = await process.mysqlPool.getConnection();
        await connection.beginTransaction();
        
        // Execute the callback with the connection
        const result = await callback(connection);
        
        // If we reach here, commit the transaction
        await connection.commit();
        connection.release();
        return result;
        
      } catch (error) {
        lastError = error;
        
        // Try to rollback if we have a connection
        if (connection) {
          try {
            await connection.rollback();
          } catch (rollbackError) {
            logger.error(`[${this.name}] Error rolling back transaction: ${rollbackError.message}`);
          } finally {
            connection.release();
          }
        }
        
        // If it's a deadlock, retry after a backoff
        if (error.errno === 1213) { // MySQL deadlock error code
          retries--;
          const backoffDelay = Math.floor(Math.random() * 1000) + 500 * (maxRetries - retries); 
          logger.warn(`[${this.name}] Deadlock detected, retrying (${retries} attempts left) after ${backoffDelay}ms`);
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
        } else {
          // For other errors, don't retry
          logger.error(`[${this.name}] Database error: ${error.message}`);
          break;
        }
      }
    }
    
    // If we got here, all retries failed
    throw lastError || new Error('Transaction failed after multiple retries');
  }
}

module.exports = DBLogStats;
