const mysql = require("mysql2/promise");

class SeedTrackerBasic {
  constructor(config) {
    this.config = config;
    this.name = "SeedTrackerBasic Plugin";
    this.interval = null;
    this.intervalMinutes = 5;
    this.seedStart = 5;
    this.seedEnd = 40;
    this.discordSeederRoleId = null;
    this.serverInstance = null;
    this.serverName = null;

    this.tableName = "seed_tracker";
  }

  async prepareToMount(serverInstance) {
    await this.cleanup();
    this.serverInstance = serverInstance;

    try {
      if (!this.config?.connectors?.mysql?.enabled || !process.mysqlPool) {
        return;
      }

      const pluginConfig = this.config.plugins.find(
        (plugin) => plugin.plugin === "SeedTrackerBasic"
      );
      if (!pluginConfig) {
        return;
      }

      this.intervalMinutes =
        typeof pluginConfig.interval === "number" && pluginConfig.interval > 0
          ? pluginConfig.interval
          : this.intervalMinutes;
      this.seedStart =
        typeof pluginConfig.seedStart === "number" ? pluginConfig.seedStart : this.seedStart;
      this.seedEnd =
        typeof pluginConfig.seedEnd === "number" ? pluginConfig.seedEnd : this.seedEnd;

      this.discordSeederRoleId =
        typeof pluginConfig.discordSeederRoleId === "string"
          ? pluginConfig.discordSeederRoleId
          : this.discordSeederRoleId;

          this.serverName =
        typeof pluginConfig.serverName === "string" ? pluginConfig.serverName : this.serverName;

      await this.setupSchema();
      await this.migrateSchema();
      this.startTracking();
    } catch (error) {}
  }

  async setupSchema() {
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
            id INT AUTO_INCREMENT PRIMARY KEY,
            playerName VARCHAR(255) NULL,
            playerUID VARCHAR(255) NOT NULL UNIQUE,
            seedValue INT DEFAULT 0,
            created TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;

    try {
      const connection = await process.mysqlPool.getConnection();
      await connection.query(createTableQuery);
      connection.release();
    } catch (error) {}
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
      
      // For multi-server support, we need to add serverName column
      if (!columnNames.includes('serverName')) {
        alterQueries.push('ADD COLUMN serverName VARCHAR(255) NULL');
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
        alterQueries.push('ADD UNIQUE INDEX playerUID_serverName (playerUID, serverName)');
      }
      
      if (alterQueries.length > 0) {
        const alterQuery = `ALTER TABLE ${this.tableName} ${alterQueries.join(', ')}`;
        await connection.query(alterQuery);
        
        if (this.serverInstance.logger) {
          this.serverInstance.logger.info(`SeedTrackerBasic: Migrated ${this.tableName} table with new columns: ${alterQueries.join(', ')}`);
        }
      } else {
        if (this.serverInstance.logger) {
          this.serverInstance.logger.info(`SeedTrackerBasic: No migration needed for ${this.tableName} table.`);
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

  startTracking() {
    const intervalMs = this.intervalMinutes * 60 * 1000;
    this.trackSeedPlayers();
    this.interval = setInterval(() => this.trackSeedPlayers(), intervalMs);
  }

  async trackSeedPlayers() {
    const players = this.serverInstance?.players;
    if (!Array.isArray(players) || players.length === 0) {
      return;
    }

    if (players.length < this.seedStart || players.length > this.seedEnd) {
      return;
    }

    for (const player of players) {
      if (player?.uid && player?.name) {
        await this.processPlayer(player);
      }
    }
  }

async processPlayer(player) {
  try {
    await process.mysqlPool.query(
      `INSERT INTO ${this.tableName} (serverName, playerName, playerUID, seedValue)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         seedValue = ${this.tableName}.seedValue + VALUES(seedValue),
         playerName = VALUES(playerName)`,
      [this.serverName, player.name, player.uid, this.intervalMinutes]
    );
  } catch (error) {
    console.error(`Error processing player ${player.name}: ${error.message}`);
  }
}

  async cleanup() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.serverInstance = null;
  }
}

module.exports = SeedTrackerBasic;
