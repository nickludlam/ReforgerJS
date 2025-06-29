const logger = require("../logger/logger");

class BattlemetricsSync {
  constructor(config) {
    this.config = config;
    this.name = "Battlemetrics Sync Plugin";
    this.isInitialized = false;

    this.syncEnabled = false; // Default to false, can be set in config
    this.fullSyncIntervalMinutes = 120; // Default sync interval in minutes
    this.incrementalSyncIntervalMinutes = 15; // Default incremental sync interval in minutes

    this.lastFullSync = null; // Timestamp of the last full sync

    this.banCache = new Map(); // Cache mapping reforgerID to ban
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
        (plugin) => plugin.plugin === "BattlemetricsSync"
      );
      if (pluginConfig) {
        if (!pluginConfig.enabled) {
          logger.verbose(`[${this.name}] Plugin is disabled in config.`);
          return;
        }

        if (pluginConfig.syncEnabled) {
          this.syncEnabled = pluginConfig.syncEnabled;
          logger.verbose(`[${this.name}] Sync is enabled in config.`);
        }

        // Check if interval is defined, is a number, and is positive
        if (
          pluginConfig.fullSyncIntervalMinutes !== undefined &&
          typeof pluginConfig.fullSyncIntervalMinutes === "number" &&
          pluginConfig.fullSyncIntervalMinutes > 0
        ) {
          this.fullSyncIntervalMinutes = pluginConfig.fullSyncIntervalMinutes;
          logger.verbose(`[${this.name}] Set full sync interval to ${this.fullSyncIntervalMinutes} minutes from config.`);
        } else {
          logger.verbose(`[${this.name}] Using default full sync interval of ${this.fullSyncIntervalMinutes} minutes.`);
        }
        // Same for incremental sync interval
        if (
          pluginConfig.incrementalSyncIntervalMinutes !== undefined &&
          typeof pluginConfig.incrementalSyncIntervalMinutes === "number" &&
          pluginConfig.incrementalSyncIntervalMinutes > 0
        ) {
          this.incrementalSyncIntervalMinutes = pluginConfig.incrementalSyncIntervalMinutes;
          logger.verbose(`[${this.name}] Set incremental sync interval to ${this.incrementalSyncIntervalMinutes} minutes from config.`);
        }
        
        if (
          pluginConfig.incrementalSyncIntervalMinutes !== undefined ||
          typeof pluginConfig.incrementalSyncIntervalMinutes === "number" &&
          pluginConfig.incrementalSyncIntervalMinutes > 0
        ) {
          this.incrementalSyncIntervalMinutes = pluginConfig.incrementalSyncIntervalMinutes;
          logger.verbose(`[${this.name}] Set incremental sync interval to ${this.incrementalSyncIntervalMinutes} minutes from config.`); 
        } else {
          logger.verbose(`[${this.name}] Using default incremental sync interval of ${this.incrementalSyncIntervalMinutes} minutes.`);
        }
      }

      // TODO: We're actually using this less as a seaprate plugin, and more like a class because other classes call getBanByReforgerUUIDs directly
      // We might want to refactor this later to be more like a plugin, and getBanByReforgerUUIDs gets refactored out to be elsewhere

      if (this.syncEnabled) {
        logger.info(`[${this.name}] Sync is enabled. Starting periodic sync...`);
        await this.setupSchema();
        await this.migrateSchema();
        this.startPeriodicSync();
      }

      this.isInitialized = true;
      logger.info(`[${this.name}] Initialized: Listening to playerJoined events and syncing bans every ${this.syncIntervalMinutes} minutes.`);
    } catch (error) {
      if (serverInstance.logger) {
        logger.error(`Error initializing Battlemetrics Sync: ${error.message}`);
      }
    }
  }

  async setupSchema() {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS battlemetricsBans (
        id INT PRIMARY KEY,
        reason TEXT NULL,
        note TEXT NULL,
        identifierType VARCHAR(50) NULL,
        identifier VARCHAR(255) NULL,
        expiresAt TIMESTAMP NULL,
        updatedAt TIMESTAMP NULL,
        KEY identifier_type_identifier (identifierType, identifier),
        tableVersion INT NOT NULL DEFAULT 1
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    `;

    const connection = await process.mysqlPool.getConnection();
    await connection.query(createTableQuery);
    connection.release();
  }

  async migrateSchema() {
  }


  async startPeriodicSync() {
    logger.info(`[${this.name}] Starting periodic sync every ${this.syncIntervalMinutes} minutes...`);

    // Initially we will perform a full sync
    await this.syncBattlemetricsData(false);

    this.syncInterval = setInterval(async () => {
      // Now decide if we're incremental or full sync
      const now = new Date();

      logger.verbose(`[${this.name}] Checking if periodic sync is needed...`);

      const shouldFullSync = !this.lastFullSync || (now - this.lastFullSync) >= (this.fullSyncIntervalMinutes * 60 * 1000);

      try {
        await this.syncBattlemetricsData(!shouldFullSync);
      } catch (error) {
        logger.error(`[${this.name}] Error during periodic sync: ${error.message}`);
      }
    }, this.incrementalSyncIntervalMinutes * 60 * 1000);
  }

  async getLatestBan() {
    const bansMap = await process.battlemetricsAPI.fetchBanList({}, 1);
    if (!bansMap || bansMap.size === 0) {
      logger.warn(`[${this.name}] No bans found in Battlemetrics.`);
      return null;
    }
    const latestBan = bansMap.values().next().value;
    if (!latestBan || !latestBan.attributes) {
      logger.warn(`[${this.name}] Latest ban data is incomplete.`);
      return null;
    }
    return latestBan;
  }

  async checkUpToDate() {
    // Fetch the latest ban from Battlemetrics
    const latestBan = await this.getLatestBan();
    if (!latestBan) {
      logger.warn(`[${this.name}] No latest ban found to check for updates.`);
      return false;
    }
    // Compare with the latest ban in the database
    const connection = await process.mysqlPool.getConnection();
    const [rows] = await connection.query(
      `SELECT * FROM battlemetricsBans WHERE id = ? ORDER BY updatedAt DESC LIMIT 1`,
      [latestBan.id]
    );

    connection.release();

    return rows.length == 1;
  }

  async syncBattlemetricsData(incremental = false) {
    logger.info(`[${this.name}] Syncing Battlemetrics data...`);

    if (incremental) {
      logger.info(`[${this.name}] Incremental sync requested. Checking for latest ban...`);
      const upToDate = await this.checkUpToDate();
      if (upToDate) {
        logger.info(`[${this.name}] Latest ban is already up to date. No sync needed.`);
        return;
      }
    }

    var connection;
    try {
      // Fetch bans from Battlemetrics
      if (!process.battlemetricsAPI) {
        logger.warn(`[${this.name}] Battlemetrics API is not initialized. Cannot sync data.`);
        return;
      }
      const pageLimit = incremental ? 1 : -1; // Use 1 for incremental sync, -1 for full sync
      const bansMap = await process.battlemetricsAPI.fetchBanList({}, pageLimit);
      if (!bansMap || bansMap.length === 0) {
        logger.info(`[${this.name}] No bans found in Battlemetrics.`);
        return;
      }

      // Each entry in the map is a ban object with id mapping to attributes. An example of the value structure is:
      // {
      //   "id": "153866004",
      //   "attributes": {
      //     "id": "153866004",
      //     "uid": "mELjXZLaa",
      //     "timestamp": "2025-06-24T13:53:20.549Z",
      //     "reason": "Intentional team-killing is not tolerated - Expires: {{expires}} - Appeal at: discord.exd.gg",
      //     "note": "<p>Intentional TK, reported by EXD member <span style=\"color: var(--header-primary)\">backifran</span></p>",
      //     "identifiers": [
      //       {
      //         "id": 638745989,
      //         "type": "reforgerUUID",
      //         "private": true,
      //         "lastSeen": "2025-06-24T13:37:08.094Z"
      //       }
      //     ],
      //     "expires": null,
      //     "autoAddEnabled": false,
      //     "nativeEnabled": null,
      //     "orgWide": true
      //   },
      // }

      // We want to map this to our database schema, but insert it efficiently using batched inserts of 500 at a time
      const batchSize = 500;
      const bansArray = Array.from(bansMap.values());
      const totalBans = bansArray.length;
      logger.info(`[${this.name}] Found ${totalBans} bans to sync from Battlemetrics.`);

      connection = await process.mysqlPool.getConnection();

      if (!incremental) {
        // If this is a full sync, we should clear the existing bans first
        logger.info(`[${this.name}] Performing full sync. Clearing existing bans in the database.`);
        await connection.query(`TRUNCATE TABLE battlemetricsBans`);
      }

      // Now chunk the insert/replace operations into batches
      for (let i = 0; i < totalBans; i += batchSize) {
        const batch = bansArray.slice(i, i + batchSize);
        const values = batch.map(ban => [
          parseInt(ban.id, 10), // Convert ban.id to an integer
          ban.attributes.reason || 'Unknown reason',
          ban.attributes.note?.replace(/<\/?[^>]+(>|$)/g, '') || null,
          ban.attributes.identifiers[0]?.type || null,
          ban.attributes.identifiers[0]?.identifier || null,
          ban.attributes.expires ? new Date(ban.attributes.expires).toISOString().slice(0, 19).replace('T', ' ') : null,
          ban.attributes.timestamp ? new Date(ban.attributes.timestamp).toISOString().slice(0, 19).replace('T', ' ') : null
        ]);

        // Prepare the insert query
        const insertQuery = `
          INSERT INTO battlemetricsBans (id, reason, note, identifierType, identifier, expiresAt, updatedAt)
          VALUES ?
          ON DUPLICATE KEY UPDATE
            reason = VALUES(reason),
            note = VALUES(note),
            identifierType = VALUES(identifierType),
            identifier = VALUES(identifier),
            expiresAt = VALUES(expiresAt),
            updatedAt = VALUES(updatedAt);
        `;

        await connection.query(insertQuery, [values]);
      }

      // Now flush the cache with the latest bans
      this.banCache.clear();

    } catch (error) {
      logger.error(`[${this.name}] Error syncing Battlemetrics data: ${error.message}`);
    } finally {
      if (connection) {
        connection.release();
      }
      this.lastFullSync = new Date(); // Update last full sync time
    }
  }

  async cleanup() {
    logger.verbose(`[${this.name}] Cleaning up...`);
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    this.isInitialized = false;
  }

  // Now export a method to get a ban by reforgerUUID
  async getBanByReforgerUUIDs(reforgerUUIDs) {
    logger.verbose(`[${this.name}] Fetching bans by reforgerUUIDs: ${reforgerUUIDs}`);

    // Check cache first
    const cachedBans = reforgerUUIDs.map(uuid => this.banCache.get(uuid)).filter(ban => ban);
    const missingUUIDs = reforgerUUIDs.filter(uuid => !this.banCache.has(uuid));

    if (missingUUIDs.length === 0) {
      logger.verbose(`[${this.name}] All reforgerUUIDs found in cache.`);
      return cachedBans;
    }

    const connection = await process.mysqlPool.getConnection();
    try {
      const [rows] = await connection.query(
        `SELECT * FROM battlemetricsBans WHERE identifierType = 'reforgerUUID' AND identifier IN (?) ORDER BY updatedAt DESC`,
        [missingUUIDs]
      );

      if (rows.length === 0) {
        logger.info(`[${this.name}] No bans found for reforgerUUIDs: ${missingUUIDs}`);
        return cachedBans;
      }

      const fetchedBans = rows.map(data => {
        const ban = {
          id: data.id,
          reason: data.reason || null,
          note: data.note || null,
          identifierType: data.identifierType || null,
          identifier: data.identifier || null,
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
          updatedAt: data.updatedAt ? new Date(data.updatedAt) : null
        };

        // Cache the ban
        this.banCache.set(data.identifier, ban);
        return ban;
      });

      logger.verbose(`[${this.name}] Bans fetched and cached for reforgerUUIDs: ${missingUUIDs}`);
      return [...cachedBans, ...fetchedBans];
    } catch (error) {
      logger.error(`[${this.name}] Error fetching bans by reforgerUUIDs: ${error.message}`);
      return cachedBans;
    } finally {
      connection.release();
    }
  }

}

module.exports = BattlemetricsSync;