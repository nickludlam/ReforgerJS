const mysql = require("mysql2/promise");
const fs = require("fs").promises;
const pathModule = require("path");

class DBLogStats {
  constructor(config) {
    this.config = config;
    this.name = "DBLogStats Plugin";
    this.interval = null;
    this.logIntervalMinutes = 15; // default interval (minutes)
    this.serverInstance = null;
    this.folderPath = null;
    this.tableName = null;
    this.serverName = null;
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
        logger.error(`[${this.name}] Folder path '${this.folderPath}' not found. Plugin disabled.`);
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
      // await this.clearTable();

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
        playerUID VARCHAR(255) NOT NULL UNIQUE,
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
        created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    try {
      const connection = await process.mysqlPool.getConnection();
      await connection.query(createTableQuery);
      connection.release();
      logger.verbose(`[${this.name}] Database schema ensured for table '${this.tableName}'.`);
    } catch (error) {
      logger.error(`[${this.name}] Failed to set up database schema: ${error.message}`);
      throw error;
    }
  }

  async migrateSchema() {
    try {
      const alterQueries = [];
      const connection = await process.mysqlPool.getConnection();
      
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

      // Now check if we still have a unique constraint on playerUID, and if we do, remove it
      const [indexes] = await connection.query(`
        SELECT INDEX_NAME
        FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = '${this.tableName}'
        AND COLUMN_NAME = 'playerUID'
        AND NON_UNIQUE = 0
      `);

      if (indexes.length > 0 && indexes[0].INDEX_NAME === 'playerUID') {
        alterQueries.push('DROP INDEX playerUID');
        alterQueries.push('ADD UNIQUE INDEX playerUID_server_name (playerUID, server_name)');
      }
      
      if (alterQueries.length > 0) {
        const alterQuery = `ALTER TABLE ${this.tableName} ${alterQueries.join(', ')}`;
        await connection.query(alterQuery);
        
        if (this.serverInstance.logger) {
          this.serverInstance.logger.info(`DBLog: Migrated stats table with new columns: ${alterQueries.join(', ')}`);
        }
      } else {
        if (this.serverInstance.logger) {
          this.serverInstance.logger.info(`DBLog: No migration needed for stats table.`);
        }
      }
      
      connection.release();
    } catch (error) {
      if (this.serverInstance.logger) {
        this.serverInstance.logger.error(`Error migrating schema: ${error.message}`);
      }
      throw error;
    }
  }

  async clearTable() {
    logger.verbose(`[${this.name}] Clearing table '${this.tableName}'...`);
    try {
      const connection = await process.mysqlPool.getConnection();
      await connection.query(`DELETE FROM \`${this.tableName}\``);
      connection.release();
      logger.verbose(`[${this.name}] Cleared table '${this.tableName}'.`);
    } catch (error) {
      logger.error(`[${this.name}] Failed to clear table: ${error.message}`);
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

    const BATCH_SIZE = 500;
    const playerEntries = Object.entries(playerStatsHash);
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
      const connection = await process.mysqlPool.getConnection();
      const [result] = await connection.execute(query, values);
      await connection.release();
    }
    return true;
  }

  async collectStats() {
    logger.verbose(`[${this.name}] Initiating stats logging cycle.`);

    // accumulate player stats as a dict mapping playerUID to stats
    const playerStatData = {};

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
        const playerUID = match[1];
        const filePath = pathModule.join(this.folderPath, file);
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

    logger.verbose(`[${this.name}] Collected stats for ${Object.keys(playerStatData).length} players.`);
    return playerStatData;
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

module.exports = DBLogStats;
