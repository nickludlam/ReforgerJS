const mysql = require("mysql2/promise");
const fs = require("fs");
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

      // Retrieve plugin configuration
      const pluginConfig = this.config.plugins.find(
        (plugin) => plugin.plugin === "DBLogStats"
      );
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
      if (!fs.existsSync(this.folderPath)) {
        logger.error(
          `[${this.name}] Folder path '${this.folderPath}' not found. Plugin disabled.`
        );
        return;
      }

      // Get the table name from config
      if (!pluginConfig.tableName) {
        logger.warn(`[${this.name}] 'tableName' not specified in config. Plugin disabled.`);
        return;
      }
      this.tableName = pluginConfig.tableName;

      // Create/ensure database schema
      await this.setupSchema();

      // Start the logging interval
      this.startLogging();
      logger.info(
        `[${this.name}] Initialized and started logging stats every ${this.logIntervalMinutes} minutes.`
      );
    } catch (error) {
      logger.error(`[${this.name}] Error during initialization: ${error.message}`);
    }
  }

  async setupSchema() {
    // The table schema includes:
    // - id (primary key)
    // - playerUID (unique)
    // - 35 stat columns (in the order given)
    // - created (timestamp)
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
        created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;

    try {
      const connection = await process.mysqlPool.getConnection();
      await connection.query(createTableQuery);
      connection.release();
      logger.verbose(`[${this.name}] Database schema ensured for table '${this.tableName}'.`);
    } catch (error) {
      logger.error(
        `[${this.name}] Failed to set up database schema: ${error.message}`
      );
      throw error;
    }
  }

  startLogging() {
    const intervalMs = this.logIntervalMinutes * 60 * 1000;
    // Run immediately and then at each interval.
    this.logStats();
    this.interval = setInterval(() => this.logStats(), intervalMs);
    logger.verbose(
      `[${this.name}] Started logging every ${this.logIntervalMinutes} minutes.`
    );
  }

  async logStats() {
    logger.verbose(`[${this.name}] Initiating stats logging cycle.`);

    try {
      // Read the folder for files
      const files = fs.readdirSync(this.folderPath);
      // Filter files that match "PlayerData.{playerUID}.json"
      const statFiles = files.filter((file) => /^PlayerData\..+\.json$/.test(file));
      if (statFiles.length === 0) {
        logger.verbose(`[${this.name}] No player stat files found in folder.`);
        return;
      }

      // Process each stat file
      for (const file of statFiles) {
        // Extract the player UID from the filename
        const match = /^PlayerData\.(.+)\.json$/.exec(file);
        if (!match) {
          continue;
        }
        const playerUID = match[1];
        const filePath = pathModule.join(this.folderPath, file);
        let fileContent;
        try {
          fileContent = fs.readFileSync(filePath, "utf8");
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
          logger.warn(
            `[${this.name}] Not enough stat entries in file ${file}. Expected at least 35, got ${stats.length}.`
          );
          continue;
        }
        // Use only the first 35 values of the stats array (ignoring any extras)
        const trimmedStats = stats.slice(0, 35);

        // Destructure according to the new mapping:
        const [
          level,                         // index 0
          level_experience,              // 1
          session_duration,              // 2
          sppointss0,                    // 3
          sppointss1,                    // 4
          sppointss2,                    // 5
          warcrimes,                     // 6
          distance_walked,               // 7
          kills,                         // 8
          ai_kills,                      // 9
          shots,                         // 10
          grenades_thrown,               // 11
          friendly_kills,                // 12
          friendly_ai_kills,             // 13
          deaths,                        // 14
          distance_driven,               // 15
          points_as_driver_of_players,   // 16
          players_died_in_vehicle,       // 17
          roadkills,                     // 18
          friendly_roadkills,            // 19
          ai_roadkills,                  // 20
          friendly_ai_roadkills,         // 21
          distance_as_occupant,          // 22
          bandage_self,                  // 23
          bandage_friendlies,            // 24
          tourniquet_self,               // 25
          tourniquet_friendlies,         // 26
          saline_self,                   // 27
          saline_friendlies,             // 28
          morphine_self,                 // 29
          morphine_friendlies,           // 30
          warcrime_harming_friendlies,   // 31
          crime_acceleration,            // 32
          kick_session_duration,         // 33
          kick_streak                    // 34
        ] = trimmedStats;

        // Update or insert the record in the database.
        try {
          const [rows] = await process.mysqlPool.query(
            `SELECT * FROM \`${this.tableName}\` WHERE playerUID = ?`,
            [playerUID]
          );
          if (rows.length > 0) {
            // Record exists; update it.
            const updateQuery = `
              UPDATE \`${this.tableName}\`
              SET level = ?,
                  level_experience = ?,
                  session_duration = ?,
                  sppointss0 = ?,
                  sppointss1 = ?,
                  sppointss2 = ?,
                  warcrimes = ?,
                  distance_walked = ?,
                  kills = ?,
                  ai_kills = ?,
                  shots = ?,
                  grenades_thrown = ?,
                  friendly_kills = ?,
                  friendly_ai_kills = ?,
                  deaths = ?,
                  distance_driven = ?,
                  points_as_driver_of_players = ?,
                  players_died_in_vehicle = ?,
                  roadkills = ?,
                  friendly_roadkills = ?,
                  ai_roadkills = ?,
                  friendly_ai_roadkills = ?,
                  distance_as_occupant = ?,
                  bandage_self = ?,
                  bandage_friendlies = ?,
                  tourniquet_self = ?,
                  tourniquet_friendlies = ?,
                  saline_self = ?,
                  saline_friendlies = ?,
                  morphine_self = ?,
                  morphine_friendlies = ?,
                  warcrime_harming_friendlies = ?,
                  crime_acceleration = ?,
                  kick_session_duration = ?,
                  kick_streak = ?
              WHERE playerUID = ?
            `;
            const updateValues = [
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
              playerUID
            ];
            await process.mysqlPool.query(updateQuery, updateValues);
          } else {
            // Record does not exist; insert a new row.
            const insertQuery = `
              INSERT INTO \`${this.tableName}\`
              (playerUID, level, level_experience, session_duration, sppointss0, sppointss1, sppointss2, warcrimes, distance_walked, kills, ai_kills, shots, grenades_thrown, friendly_kills, friendly_ai_kills, deaths, distance_driven, points_as_driver_of_players, players_died_in_vehicle, roadkills, friendly_roadkills, ai_roadkills, friendly_ai_roadkills, distance_as_occupant, bandage_self, bandage_friendlies, tourniquet_self, tourniquet_friendlies, saline_self, saline_friendlies, morphine_self, morphine_friendlies, warcrime_harming_friendlies, crime_acceleration, kick_session_duration, kick_streak)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            const insertValues = [
              playerUID,
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
              kick_streak
            ];
            await process.mysqlPool.query(insertQuery, insertValues);
          }
        } catch (dbError) {
          logger.error(
            `[${this.name}] Database error processing UID ${playerUID}: ${dbError.message}`
          );
        }
      }
      logger.info(`[${this.name}] Stats logging cycle completed.`);
    } catch (error) {
      logger.error(`[${this.name}] Error during stats logging: ${error.message}`);
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

module.exports = DBLogStats;
