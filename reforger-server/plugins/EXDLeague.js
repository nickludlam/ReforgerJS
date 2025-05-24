const logger = require("../logger/logger");

class EXDLeague {
  constructor(config) {
    this.config = config;
    this.name = "EXD League Plugin";
    this.interval = null;
    this.intervalMinutes = 2;
    this.serverInstance = null;
    this.serverName = null;

    this.blacklistBEGUIDs = [];

    this.rateLimit = 10; // 10 seconds
    this.lastRanAt = 0;

    this.leagueStatsTableName = "exd_league_stats";
    this.leagueSettingsTableName = "exd_league_settings";
    this.playerStatsTableName = "player_stats";
  }

  async prepareToMount(serverInstance) {
    await this.cleanup();
    this.serverInstance = serverInstance;

    try {
      if (!this.config?.connectors?.mysql?.enabled || !process.mysqlPool) {
        return;
      }

      const pluginConfig = this.config.plugins.find(
        (plugin) => plugin.plugin === "EXDLeague"
      );
      if (!pluginConfig) { return; }
      
      // get the DBPlayerStats table name from the config
      const dbLogStatsConfig = this.config?.plugins?.find(
        (plugin) => plugin.plugin === "DBLogStats" && plugin.enabled
      );
      if (!dbLogStatsConfig) {
        logger.warn(`[${this.name}] DBLogStats plugin is not enabled in the configuration. Plugin disabled.`);
        return;
      }
      this.playerStatsTableName = dbLogStatsConfig.tableName;
      if (!this.playerStatsTableName || this.playerStatsTableName === "") {
        logger.error(`[${this.name}] DBLogStats plugin configuration is missing the tableName field.`);
        return;
      }

      this.serverName = dbLogStatsConfig.serverName;
      if (!this.serverName || this.serverName === "") {
        logger.error(`[${this.name}] DBLogStats plugin configuration is missing the serverName field.`);
        return;
      }

      // Also get the whitelist from the AltChecker plugin and store it as a blacklist Set
      const altCheckerConfig = this.config.plugins.find(
        (plugin) => plugin.plugin === "AltChecker"
      );
      if (altCheckerConfig && altCheckerConfig.whitelistBEGUIDs) {
        this.blacklistBEGUIDs = altCheckerConfig.whitelistBEGUIDs.map(guid => guid.toLowerCase());
        if (this.blacklistBEGUIDs.length > 0) {
          logger.info(`[${this.name}] Loaded ${this.blacklistBEGUIDs.length} blacklist BE GUIDs.`);
        }
      }

      await this.setupSchema();
      logger.verbose(`[${this.name}] Schema setup complete.`);
      await this.migrateSchema();
      logger.verbose(`[${this.name}] Schema migration complete.`);
      
      // Listen for the serverInstance to emit the 'playerStatsUpdated' event
      if (this.serverInstance) {
        this.serverInstance.on("playerStatsUpdated", this.updateCurrentLeagueStats.bind(this));
        logger.verbose(`[${this.name}] Listening for playerStatsUpdated event.`);
      } else {
        logger.error(`[${this.name}] Server instance is not available. Cannot listen for playerStatsUpdated event.`);
      }

      this.startTrackingActivePlayers();
    } catch (error) {
      logger.error(`[${this.name}] Error initializing EXDLeague plugin: ${error}`);
    }
  }

  async setupSchema() {
    // The idea is to populate this table with data from player_stats table,
    // with a baseline snapshot (leagueNumber N is_initial_snapshot=1) and current stats (leagueNumber N, is_initial_snapshot=0)
    // This allows us to track progress during a league period
    const createStatsTableQuery = `
        CREATE TABLE IF NOT EXISTS ${this.leagueStatsTableName} (
            id INT AUTO_INCREMENT PRIMARY KEY,
            playerUID VARCHAR(255) NOT NULL,
            server_name VARCHAR(255) NOT NULL,
            league_number INT DEFAULT 0,
            is_initial_snapshot TINYINT DEFAULT 0,
            minutes_played FLOAT DEFAULT 0,
            deaths FLOAT DEFAULT 0,
            kills FLOAT DEFAULT 0,
            ai_kills FLOAT DEFAULT 0,
            friendly_kills FLOAT DEFAULT 0,
            friendly_ai_kills FLOAT DEFAULT 0,
            distance_walked FLOAT DEFAULT 0,
            distance_driven FLOAT DEFAULT 0,
            bandage_friendlies FLOAT DEFAULT 0,
            tourniquet_friendlies FLOAT DEFAULT 0,
            saline_friendlies FLOAT DEFAULT 0,
            morphine_friendlies FLOAT DEFAULT 0,
            UNIQUE INDEX idx_player_server_league_snap (playerUID, server_name, league_number, is_initial_snapshot)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    `;

    const createLeagueSettingsTableQuery = `
        CREATE TABLE IF NOT EXISTS ${this.leagueSettingsTableName} (
            id INT AUTO_INCREMENT PRIMARY KEY,
            league_number INT NOT NULL,
            server_name VARCHAR(255) NOT NULL,
            league_start DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE INDEX idx_league_number_server_name (league_number, server_name),
            INDEX idx_league_start (league_start)
        ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    `;

    try {
      const connection = await process.mysqlPool.getConnection();
      await connection.query(createStatsTableQuery);
      await connection.query(createLeagueSettingsTableQuery);
      connection.release();
      logger.verbose(`[${this.name}] Database schema setup complete.`);
    } catch (error) {
      logger.error(`[${this.name}] Error setting up schema: ${error}`);
      throw error;
    }
  }

  async migrateSchema() {
    // Add server_name column to leagueStats table if it doesn't exist
    try {
      const alterQueries = [];
      const connection = await process.mysqlPool.getConnection();
      
      const [columns] = await connection.query(`
        SELECT COLUMN_NAME 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = '${this.leagueSettingsTableName}'
      `);
      
      const columnNames = columns.map(col => col.COLUMN_NAME);
      
      // For multi-server support, we need to add server_name column
      if (!columnNames.includes('server_name')) {
        alterQueries.push('ADD COLUMN server_name VARCHAR(255) NULL');
      }
      
      if (alterQueries.length > 0) {
        const alterQuery = `ALTER TABLE ${this.leagueSettingsTableName} ${alterQueries.join(', ')}`;
        await connection.query(alterQuery);

        logger.info(`[${this.name}] Migrated settings table with new columns: ${alterQueries.join(', ')}`);
      } else {
        logger.info(`[${this.name}] No migration needed for settings table.`);
      }

      // Now migrate the stats table
      const [statsColumns] = await connection.query(`
        SELECT COLUMN_NAME 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = '${this.leagueStatsTableName}'
      `);
      const statsColumnNames = statsColumns.map(col => col.COLUMN_NAME);
      const statsAlterQueries = [];
      
      // if we don't have the is_initial_snapshot column, add it
      if (!statsColumnNames.includes('is_initial_snapshot')) {
        statsAlterQueries.push('ADD COLUMN is_initial_snapshot TINYINT DEFAULT 0');
      }

      if (statsAlterQueries.length > 0) {
        const statsAlterQuery = `ALTER TABLE ${this.leagueStatsTableName} ${statsAlterQueries.join(', ')}`;
        await connection.query(statsAlterQuery);
        logger.info(`[${this.name}] Migrated league stats table with new columns: ${statsAlterQueries.join(', ')}`);
      } else {
        logger.info(`[${this.name}] No migration needed for league stats table.`);
      }
      
      connection.release();
    } catch (error) {
      if (this.serverInstance.logger) {
        logger.error(`[${this.name}] Error migrating schema: ${error.message}`);
      }
      throw error;
    }
  }

  async getCurrentLeagueNumber(connection) {
    // 1. Get the current league number
    const [rows] = await connection.query(
      `SELECT MAX(league_number) AS maxLeagueNumber FROM ${this.leagueSettingsTableName} WHERE server_name = ?`,
      [this.serverName]
    );

    if (rows.length !== 1 || rows[0].maxLeagueNumber === null || rows[0].maxLeagueNumber < 1) {
      logger.verbose(`[${this.name}] No valid league number found.`);
      return null;
    }

    const currentLeagueNumber = rows[0].maxLeagueNumber;
    // logger.verbose(`[${this.name}] Current league number: ${currentLeagueNumber}`);
    return currentLeagueNumber;
  }

  async getPlayerUIDByName(playerName) {
    const connection = await process.mysqlPool.getConnection();

    const searchName = '%' + playerName + '%';
    logger.verbose(`[${this.name}] Getting playerUID for name: ${playerName}`);


    const [rows] = await connection.query(
      `SELECT playerUID FROM players WHERE playerName LIKE ?`,
      [searchName]
    );
    connection.release();
    if (rows.length === 0) {
      logger.warn(`[${this.name}] No player found with name: ${playerName}`);
      return null;
    }
    if (rows.length > 1) {
      // Try an exact match just in case it's a name which happens to be a substring of many players
      const [exactMatchRows] = await connection.query(
        `SELECT playerUID FROM players WHERE playerName = ?`,
        [playerName]
      );
      if (exactMatchRows.length > 0) {
        const playerUID = exactMatchRows[0].playerUID;
        logger.verbose(`[${this.name}] Found playerUID: ${playerUID} for exact name: ${playerName}`);
        connection.release();
        return playerUID;
      }

      logger.warn(`[${this.name}] Multiple players found with name: ${playerName}`);
      return null;
    }
    const playerUID = rows[0].playerUID;
    logger.verbose(`[${this.name}] Found playerUID: ${playerUID}`);
    return playerUID;
  }


  async startNewLeague() {
    logger.verbose(`[${this.name}] Starting new league on ${this.serverName}...`);
    let connection;
    try {
      let newLeagueNumber = 1;
      // Get the max league number from the leagueSettings table
      connection = await process.mysqlPool.getConnection();
      await connection.beginTransaction();

      // Query the existing league settings to get the last league number we used
      const currentLeagueNumber = await this.getCurrentLeagueNumber(connection);
      if (currentLeagueNumber) {
        newLeagueNumber = currentLeagueNumber + 1;
      }

      // Now we need to insert the new league number into the leagueSettings table
      const insertLeagueNumberQuery = `
        INSERT INTO ${this.leagueSettingsTableName} (server_name, league_number, league_start)
        VALUES (?, ?, CURRENT_TIMESTAMP)
      `;

      logger.verbose(`[${this.name}] New league number: ${newLeagueNumber}`);

      // Define columns we want to track for league stats
      const playerStatColumns = [
        'deaths',
        'kills',
        'ai_kills',
        'friendly_kills',
        'friendly_ai_kills',
        'distance_walked',
        'distance_driven',
        'bandage_friendlies',
        'tourniquet_friendlies',
        'saline_friendlies',
        'morphine_friendlies',
      ];

      // Get active players from the last 15 days
      const activePlayersQuery = `
        SELECT playerUID FROM players WHERE lastSeen >= NOW() - INTERVAL 15 DAY
      `;
      const [activePlayerRows] = await connection.query(activePlayersQuery);
      if (activePlayerRows.length === 0) {
        logger.warn(`[${this.name}] No active players found. Skipping league creation.`);
        await connection.rollback();
        connection.release();
        return;
      }
      const activePlayerUIDs = activePlayerRows.map(row => row.playerUID);
      logger.info(`[${this.name}] Found ${activePlayerUIDs.length} active players for new league.`);

      // Check for duplicates (should not happen with proper DB constraints)
      const uniquePlayerUIDs = [...new Set(activePlayerUIDs)];
      if (uniquePlayerUIDs.length !== activePlayerUIDs.length) {
        logger.warn(`[${this.name}] Duplicate playerUIDs found in active players query.`);
        const duplicatePlayerUIDs = activePlayerUIDs.filter((uid, index) => {
          return activePlayerUIDs.indexOf(uid) !== index;
        });
        logger.warn(`[${this.name}] Duplicate playerUIDs: ${duplicatePlayerUIDs.join(', ')}`);
      }

      // Insert the new league number into the leagueSettings table
      await connection.query(insertLeagueNumberQuery, [this.serverName, newLeagueNumber]);

      // check if we have any rows for league N where is_initial_snapshot = 1
      const createBaselineSnapshot = `
        INSERT INTO ${this.leagueStatsTableName} (
          playerUID,
          league_number,
          server_name,
          is_initial_snapshot,
          minutes_played,
          ${playerStatColumns.join(", ")}
        )
        SELECT 
          ps.playerUID,
          ${newLeagueNumber},
          ps.server_name,
          1,
          0,
          ${playerStatColumns.map(col => `IFNULL(ps.${col}, 0)`).join(", ")}
        FROM ${this.playerStatsTableName} ps
        INNER JOIN players p ON ps.playerUID = p.playerUID
        WHERE p.lastSeen >= DATE_SUB(NOW(), INTERVAL 2 WEEK)
        AND ps.server_name = ?
      `;
      logger.verbose(`[${this.name}] Base snapshot query: ${createBaselineSnapshot}`);
      const baseSnapshotResult = await connection.query(createBaselineSnapshot, [this.serverName]);
      if (baseSnapshotResult[0].affectedRows === 0) {
        logger.warn(`[${this.name}] No stats found for baseline (league ${newLeagueNumber - 1}).`);
      } else {
        logger.info(`[${this.name}] Baseline stats captured for ${baseSnapshotResult[0].affectedRows} players.`);
      }

      const createInitialLeagueStats = `
          INSERT INTO ${this.leagueStatsTableName} (
            playerUID,
            league_number,
            server_name,
            is_initial_snapshot,
            minutes_played,
            ${playerStatColumns.join(", ")}
          )
          SELECT 
            ps.playerUID,
            ${newLeagueNumber},
            ps.server_name,
            0,
            0,
            ${playerStatColumns.map(col => `IFNULL(ps.${col}, 0)`).join(", ")}
          FROM ${this.playerStatsTableName} ps
          INNER JOIN players p ON ps.playerUID = p.playerUID
          WHERE p.lastSeen >= DATE_SUB(NOW(), INTERVAL 2 WEEK)
          AND ps.server_name = ?
        `;

      
      // Execute the current snapshot query for league N (will be updated as players play)
      const createInitialLeagueStatsResults = await connection.query(createInitialLeagueStats, 
        [this.serverName]);
        
      if (createInitialLeagueStatsResults[0].affectedRows === 0) {
        logger.warn(`[${this.name}] No stats initialized for new league ${newLeagueNumber}.`);
        await connection.rollback();
        connection.release();
        return;
      }

      await connection.commit();
      logger.info(`[${this.name}] League ${newLeagueNumber} initialized with ${createInitialLeagueStatsResults[0].affectedRows} players.`);
    } catch (error) {
      logger.error(`[${this.name}] Error initializing league: ${error.message}`);
      if (connection) {
        try {
          await connection.rollback();
        } catch (rollbackError) {
          logger.error(`[${this.name}] Error during rollback: ${rollbackError.message}`);
        }
      }
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }

  async wipeAllLeagueStats() {
    logger.verbose(`[${this.name}] Wiping all league stats...`);
    let connection = null;

    try {
      connection = await process.mysqlPool.getConnection();
      const deleteLeagueStatsQuery = `DELETE FROM ${this.leagueStatsTableName}`;
      const deleteLeagueSettingsQuery = `DELETE FROM ${this.leagueSettingsTableName}`;
      await connection.query(deleteLeagueStatsQuery);
      await connection.query(deleteLeagueSettingsQuery);
      logger.info(`[${this.name}] All league stats wiped.`);
    } catch (error) {
      logger.error(`[${this.name}] Error wiping league stats: ${error.message}`);
    } finally {
      // Always release the connection in a finally block
      if (connection) {
        connection.release();
      }
    }
  }

  async updateCurrentLeagueStats() {
    let connection;
    
    // Check the rate limiter
    const start = Date.now();
    if (start - this.lastRanAt < this.rateLimit * 1000) {
      return;
    } else {
      this.lastRanAt = start;
      logger.verbose(`[${this.name}] Rate limit passed. Proceeding with update.`);
    }

    logger.verbose(`[${this.name}] Updating current league stats...`);

    try {
      // Get the current league number from the leagueSettings table
      connection = await process.mysqlPool.getConnection();
      await connection.beginTransaction();

      // 1. Get the current league number
      const currentLeagueNumber = await this.getCurrentLeagueNumber(connection);
      if (currentLeagueNumber === null) {
        logger.verbose(`[${this.name}] No valid league number found. Skipping update.`);
        await connection.rollback();
        connection.release();
        return;
      }
      
      // logger.verbose(`[${this.name}] Current league number: ${currentLeagueNumber}`);

      // Define columns we want to track for league stats - must match the schema
      const playerStatColumns = [
        'deaths',
        'kills',
        'ai_kills',
        'friendly_kills',
        'friendly_ai_kills',
        'distance_walked',
        'distance_driven',
        'bandage_friendlies',
        'tourniquet_friendlies',
        'saline_friendlies',
        'morphine_friendlies',
      ];

      // Update current league stats from player_stats for all players in this league
      const updateStatsQuery = `
        UPDATE ${this.leagueStatsTableName} ls
        JOIN ${this.playerStatsTableName} ps ON ls.playerUID = ps.playerUID AND ls.server_name = ps.server_name
        SET 
          ${playerStatColumns.map(col => `ls.${col} = ps.${col}`).join(", ")}
        WHERE ls.league_number = ? AND is_initial_snapshot = 0
      `;

      const [updateResult] = await connection.query(updateStatsQuery, [currentLeagueNumber]);

      await connection.commit();

      const end = Date.now();
      const elapsed = end - start;

      connection.release();
      
      logger.info(`[${this.name}] League stats updated successfully for league ${currentLeagueNumber} - ${updateResult.affectedRows} players updated in ${elapsed}ms`);
    } catch (error) {
      logger.error(`[${this.name}] Error updating league stats: ${error.message}`);
      if (connection) {
        try {
          await connection.rollback();
        } catch (rollbackError) {
          logger.error(`[${this.name}] Error during rollback: ${rollbackError.message}`);
        }
        connection.release();
      }
    }
  }
  
  startTrackingActivePlayers() {
    const intervalMs = this.intervalMinutes * 60 * 1000;
    this.updateCurrentLeagueMinutesPlayed();
    this.interval = setInterval(() => this.updateCurrentLeagueMinutesPlayed(), intervalMs);
  }

  async updateCurrentLeagueMinutesPlayed() {
    logger.verbose(`[${this.name}] Updating current league minutes played...`);

    const players = this.serverInstance?.players;
    if (!Array.isArray(players) || players.length === 0) {
      logger.warn(`[${this.name}] No players found. Skipping update.`);
      return;
    }

    // Collect the playerUIDs from the players array
    const playerUIDs = players.map((player) => player.uid).filter((uid) => uid);
    if (playerUIDs.length === 0) {
      logger.warn(`[${this.name}] No playerUIDs found. Skipping update.`);
      return;
    }

    let connection = null;

    try {
      const start = Date.now();

      connection = await process.mysqlPool.getConnection();
      // start a transaction
      await connection.beginTransaction();

      // 1. Get the current league number
      const currentLeagueNumber = await this.getCurrentLeagueNumber(connection);
      if (currentLeagueNumber === null) {
        logger.verbose(`[${this.name}] No valid league number found. Skipping update.`);
        await connection.rollback();
        connection.release();
        return;
      }

      const updateQuery = `
        UPDATE ${this.leagueStatsTableName}
        SET minutes_played = minutes_played + ?
        WHERE playerUID IN (?)
        AND league_number = ? and server_name = ? AND is_initial_snapshot = 0
      `;

      await connection.query(updateQuery, [this.intervalMinutes, playerUIDs, currentLeagueNumber, this.serverName]);
      // commit the transaction
      await connection.commit();

      const end = Date.now();
      const elapsed = end - start;

      // Get the time it took to run the query
      logger.verbose(`[${this.name}] Updating league minutes played took ${elapsed}ms`);

      connection.release();
      logger.info(`[${this.name}] Updated current ${this.serverName} league minutes played for ${playerUIDs.length} players in league number ${currentLeagueNumber}.`);
    } catch (error) {
      logger.error(`[${this.name}] Error updating current league minutes played: ${error.message}`);
      // rollback the transaction
      if (connection) await connection.rollback();
    } finally {
      if (connection) connection.release();
    }
  }

  /**
   * Get the difference between current and initial league stats
   * Uses is_initial_snapshot flag to get the baseline stats for comparison
   * rather than comparing against previous league number
   * 
   * @param {number} limit - Maximum number of results to return
   * @param {string} sortBy - Column to sort by
   * @param {string} order - Sort direction (ASC or DESC)
   * @param {string|null} playerUID - Optional playerUID to center results around
   * @returns {Object} League stats diff
   */
  async getLeagueStatsDiff(playerUID = null, limit = 100, sortBy = 'minutes_played_in_league', order = 'DESC') {
    logger.verbose(`[${this.name}] Getting league stats diff...`);
    let connection;
    
    try {
      // Valid sort columns
      const validSortColumns = [
        'minutes_played_in_league', 'diff_kills', 'diff_ai_kills', 
        'diff_deaths', 'diff_distance_walked', 'diff_distance_driven', 
        'kd_ratio', 'diff_friendly_kills', 'diff_friendly_ai_kills', 'total_medical',
      ];
      
      // Sanitize input
      if (!validSortColumns.includes(sortBy)) {
        logger.warn(`[${this.name}] Invalid sort column: ${sortBy}. Defaulting to 'minutes_played_in_league'.`);
        sortBy = 'minutes_played_in_league';
      }
      
      order = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

      connection = await process.mysqlPool.getConnection();
      
      // 1. Get the current league number
      const currentLeagueNumber = await this.getCurrentLeagueNumber(connection);
      if (currentLeagueNumber === null) {
        logger.warn(`[${this.name}] No valid league number found.`);
        connection.release();
        return null;
      }

      // 2. Get the league stats diff for the current league number
      logger.verbose(`[${this.name}] Getting stats diff for league number ${currentLeagueNumber}`);

      // Define the columns we want to include in the diff
      const playerStatColumns = [
        'deaths',
        'kills',
        'ai_kills',
        'friendly_kills',
        'friendly_ai_kills',
        'distance_walked',
        'distance_driven',
        'bandage_friendlies',
        'tourniquet_friendlies',
        'saline_friendlies',
        'morphine_friendlies',
        'minutes_played'
      ];

      // If playerUID is provided, we need to find its position in the sorted results
      let playerPosition = -1;
      let totalPlayersCount = 0;
      let diffResults = [];
      
      if (playerUID) {
        // First, get the row number for the specified playerUID
        const rankQuery = `
          SELECT position, total_count FROM (
            SELECT 
              playerUID,
              ROW_NUMBER() OVER (ORDER BY ${sortBy} ${order}) AS position,
              COUNT(*) OVER () AS total_count
            FROM (
              SELECT 
                curr.playerUID,
                (curr.minutes_played - IFNULL(base.minutes_played, 0)) AS minutes_played_in_league,
                ${playerStatColumns
                  .filter(col => col !== 'minutes_played')
                  .map(col => `(IFNULL(curr.${col}, 0) - IFNULL(base.${col}, 0)) AS diff_${col}`)
                  .join(', ')},
                IF(
                  (IFNULL(curr.kills, 0) - IFNULL(base.kills, 0)) > 0,
                  (IFNULL(curr.kills, 0) - IFNULL(base.kills, 0)) / 
                  GREATEST(IFNULL(curr.deaths, 0) - IFNULL(base.deaths, 0), 1),
                  0
                ) AS kd_ratio,
                (
                  (IFNULL(curr.bandage_friendlies, 0) - IFNULL(base.bandage_friendlies, 0)) + 
                  (IFNULL(curr.tourniquet_friendlies, 0) - IFNULL(base.tourniquet_friendlies, 0)) + 
                  (IFNULL(curr.saline_friendlies, 0) - IFNULL(base.saline_friendlies, 0)) + 
                  (IFNULL(curr.morphine_friendlies, 0) - IFNULL(base.morphine_friendlies, 0))
                ) AS total_medical
              FROM ${this.leagueStatsTableName} curr
              LEFT JOIN ${this.leagueStatsTableName} base 
                ON curr.playerUID = base.playerUID 
                AND base.league_number = curr.league_number
                AND base.server_name = curr.server_name
                AND base.is_initial_snapshot = 1
              JOIN players p ON curr.playerUID = p.playerUID
              WHERE curr.league_number = ?
              AND curr.server_name = ?
              AND curr.is_initial_snapshot = 0
              ${this.blacklistBEGUIDs && this.blacklistBEGUIDs.length > 0 ? 'AND p.beGUID NOT IN (?)' : ''}
              AND curr.minutes_played > 0
            ) AS filtered_stats
          ) AS ranked
          WHERE playerUID = ?
        `;

        // Prepare parameters for the rank query
        let rankParams = [currentLeagueNumber, this.serverName];
        
        if (this.blacklistBEGUIDs && this.blacklistBEGUIDs.length > 0) {
          rankParams.push(this.blacklistBEGUIDs);
        }
        
        rankParams.push(playerUID);
        
        const [rankResult] = await connection.query(rankQuery, rankParams);
        
        if (rankResult && rankResult.length > 0) {
          playerPosition = rankResult[0].position;
          totalPlayersCount = rankResult[0].total_count;
          
          // Calculate the offset to center the player in the results
          // We want the player to be in the middle of the results if possible
          const halfLimit = Math.floor(limit / 2);
          let offset = Math.max(0, playerPosition - halfLimit - 1); // -1 because ROW_NUMBER() starts at 1
          
          // Adjust offset if we're near the end of the result set
          if (offset + limit > totalPlayersCount) {
            offset = Math.max(0, totalPlayersCount - limit);
          }
          
          logger.verbose(`[${this.name}] Player ${playerUID} is at position ${playerPosition} of ${totalPlayersCount}. Using offset ${offset}`);
          
          // Now get the actual stats with LIMIT and OFFSET
          let mainQuery = this.buildLeagueStatsDiffQuery(playerStatColumns);
          mainQuery += `
            AND curr.minutes_played > 0
            ORDER BY ${sortBy} ${order}
            LIMIT ? OFFSET ?
          `;
          
          // Prepare parameters
          let params = [currentLeagueNumber, this.serverName];
          
          if (this.blacklistBEGUIDs && this.blacklistBEGUIDs.length > 0) {
            params.push(this.blacklistBEGUIDs);
          }
          
          params.push(limit, offset);
          
          [diffResults] = await connection.query(mainQuery, params);
        } else {
          logger.warn(`[${this.name}] Player ${playerUID} not found in league stats.`);
          // Fall back to standard query without centering
          playerUID = null;
        }
      }
      
      // If playerUID wasn't provided or the player wasn't found, run the standard query
      if (!playerUID) {
        // Query to calculate diff between current league stats and baseline (using is_initial_snapshot)
        let diffQuery = this.buildLeagueStatsDiffQuery(playerStatColumns);
        
        diffQuery += `
          AND curr.minutes_played > 10
          ORDER BY ${sortBy} ${order}
          LIMIT ?
        `;
        
        // Prepare parameters - only include blacklist if it's not empty
        let params = [
          currentLeagueNumber,
          this.serverName
        ];
        
        // Only add the blacklist parameter if we have entries
        if (this.blacklistBEGUIDs && this.blacklistBEGUIDs.length > 0) {
          params.push(this.blacklistBEGUIDs);
        }
        
        // Add the limit parameter
        params.push(limit);
        
        // Enable query logging for debugging
        logger.verbose(`[${this.name}] Diff query:\n${diffQuery}`);
        
        [diffResults] = await connection.query(diffQuery, params);
      }

      // Get the league settings to include start date
      const [leagueSettings] = await connection.query(
        `SELECT league_start FROM ${this.leagueSettingsTableName} WHERE league_number = ? AND server_name = ?`,
        [currentLeagueNumber, this.serverName]
      );

      // Also get the total number of participants in the league
      const [totalEntrants] = await connection.query(
        `SELECT COUNT(*) AS total FROM ${this.leagueStatsTableName} WHERE league_number = ? AND server_name = ? AND is_initial_snapshot = 0`,
        [currentLeagueNumber, this.serverName]
      );

      const result = {
        league: {
          number: currentLeagueNumber,
          startDate: leagueSettings.length > 0 ? leagueSettings[0].league_start : null,
          totalEntrantCount: totalEntrants[0].total,
          resultCount: diffResults.length,
        },
        players: diffResults
      };
      
      // If a specific player was requested and found, include their position in the response
      if (playerPosition > 0) {
        result.requestedPlayer = {
          uid: playerUID,
          position: playerPosition,
          totalPlayerCount: totalPlayersCount
        };
      }
      
      connection.release();
      return result;
    } catch (error) {
      logger.error(`[${this.name}] Error getting league stats diff: ${error.message}`);
      if (connection) {
        connection.release();
      }
      return null;
    }
  }

  buildLeagueStatsDiffQuery(playerStatColumns) {
    return `
      SELECT 
        curr.playerUID,
        p.playerName,
        curr.league_number,
        p.device,
        base.minutes_played AS baseline_minutes_played,
        curr.minutes_played,
        (curr.minutes_played - IFNULL(base.minutes_played, 0)) AS minutes_played_in_league,
        ${playerStatColumns
          .filter(col => col !== 'minutes_played')
          .map(col => 
            `IFNULL(curr.${col}, 0) AS ${col}, 
             IFNULL(base.${col}, 0) AS baseline_${col}, 
             (IFNULL(curr.${col}, 0) - IFNULL(base.${col}, 0)) AS diff_${col}`
          ).join(', ')},
        IF(
          (IFNULL(curr.kills, 0) - IFNULL(base.kills, 0)) > 0,
          (IFNULL(curr.kills, 0) - IFNULL(base.kills, 0)) / 
          GREATEST(IFNULL(curr.deaths, 0) - IFNULL(base.deaths, 0), 1),
          0
        ) AS kd_ratio,
        (
          (IFNULL(curr.bandage_friendlies, 0) - IFNULL(base.bandage_friendlies, 0)) + 
          (IFNULL(curr.tourniquet_friendlies, 0) - IFNULL(base.tourniquet_friendlies, 0)) + 
          (IFNULL(curr.saline_friendlies, 0) - IFNULL(base.saline_friendlies, 0)) + 
          (IFNULL(curr.morphine_friendlies, 0) - IFNULL(base.morphine_friendlies, 0))
        ) AS total_medical
      FROM ${this.leagueStatsTableName} curr
      LEFT JOIN ${this.leagueStatsTableName} base 
        ON curr.playerUID = base.playerUID 
        AND base.league_number = curr.league_number
        AND base.server_name = curr.server_name
        AND base.is_initial_snapshot = 1
      JOIN players p ON curr.playerUID = p.playerUID
      WHERE curr.league_number = ?
      AND curr.server_name = ?
      AND curr.is_initial_snapshot = 0
      ${this.blacklistBEGUIDs && this.blacklistBEGUIDs.length > 0 ? 'AND p.beGUID NOT IN (?)' : ''}`;
  }

  async cleanup() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }  

    if (this.serverInstance) {
      this.serverInstance.removeAllListeners("playerStatsUpdated");
      this.serverInstance = null;
    }
  }
}

module.exports = EXDLeague;
