const mysql = require("mysql2/promise");

class SeedTrackerBasic {
    constructor(config) {
        this.config = config;
        this.name = "SeedTrackerBasic Plugin";
        this.interval = null;
        this.intervalMinutes = 5;
        this.seedStart = 5;
        this.seedEnd = 40;
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
                (plugin) => plugin.plugin === "SeedTrackerBasic"
            );

            if (!pluginConfig) {
                logger.warn(`[${this.name}] Plugin configuration is missing. Plugin disabled.`);
                return;
            }

            if (typeof pluginConfig.interval === "number" && pluginConfig.interval > 0) {
                this.intervalMinutes = pluginConfig.interval;
            }

            if (typeof pluginConfig.seedStart === "number" && typeof pluginConfig.seedEnd === "number") {
                this.seedStart = pluginConfig.seedStart;
                this.seedEnd = pluginConfig.seedEnd;
            }

            await this.setupSchema();
            this.startTracking();
            logger.info(
                `[${this.name}] Initialized and tracking players every ${this.intervalMinutes} minutes.`
            );
        } catch (error) {
            logger.error(
                `[${this.name}] Error during initialization: ${error.message}`
            );
        }
    }

    async setupSchema() {
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS seed_tracker (
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
            logger.verbose(`[${this.name}] Database schema ensured.`);
        } catch (error) {
            logger.error(
                `[${this.name}] Failed to set up database schema: ${error.message}`
            );
            throw error;
        }
    }

    startTracking() {
        const intervalMs = this.intervalMinutes * 60 * 1000;
        this.trackSeedPlayers();
        this.interval = setInterval(() => this.trackSeedPlayers(), intervalMs);
        logger.verbose(
            `[${this.name}] Started tracking players every ${this.intervalMinutes} minutes.`
        );
    }

    async trackSeedPlayers() {
        logger.verbose(`[${this.name}] Initiating seed tracking cycle.`);
        const players = this.serverInstance.players;

        if (!Array.isArray(players) || players.length === 0) {
            logger.warn(`[${this.name}] No players found to track.`);
            return;
        }

        if (players.length < this.seedStart || players.length > this.seedEnd) {
            logger.verbose(
                `[${this.name}] Player count (${players.length}) is outside the seed range (${this.seedStart}-${this.seedEnd}). Skipping tracking.`
            );
            return;
        }

        for (const player of players) {
            if (!player.uid || !player.name) {
                logger.warn(
                    `[${this.name}] Skipping player due to missing UID or name.`
                );
                continue;
            }
            await this.processPlayer(player);
        }

        logger.verbose(`[${this.name}] Seed tracking cycle completed.`);
    }

    async processPlayer(player) {
        try {
            const [rows] = await process.mysqlPool.query(
                "SELECT * FROM seed_tracker WHERE playerUID = ?",
                [player.uid]
            );

            if (rows.length > 0) {
                // Player exists, increment seedValue
                await process.mysqlPool.query(
                    "UPDATE seed_tracker SET seedValue = seedValue + 1 WHERE playerUID = ?",
                    [player.uid]
                );
            } else {
                // Player does not exist, insert a new record
                const insertQuery = `
                    INSERT INTO seed_tracker (playerName, playerUID, seedValue)
                    VALUES (?, ?, 1)
                `;
                await process.mysqlPool.query(insertQuery, [
                    player.name,
                    player.uid
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
            logger.verbose(`[${this.name}] Cleared tracking interval.`);
        }
        logger.info(`[${this.name}] Cleanup completed.`);
    }
}

module.exports = SeedTrackerBasic;
