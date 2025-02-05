const { EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');

class BasicStatsEmbed {
  constructor(config) {
    this.config = config;
    this.name = "BasicStatsEmbed Plugin";
    this.interval = null;
    this.serverInstance = null;
    this.discordClient = null;
    this.channel = null;
    this.message = null;
    this.dbLogStatsTableName = null;
  }

  async prepareToMount(serverInstance, discordClient) {
    logger.verbose(`[${this.name}] Preparing to mount...`);
    this.serverInstance = serverInstance;
    this.discordClient = discordClient;

    try {
      // Check that MySQL is available.
      if (!process.mysqlPool) {
        logger.error(
          `[${this.name}] MySQL pool is not available. Ensure MySQL is connected before enabling this plugin.`
        );
        return;
      }

      // Verify that both DBLogStats and DBLog plugins are enabled.
      const dbLogStatsConfig = this.config.plugins.find(
        p => p.plugin === "DBLogStats" && p.enabled
      );
      const dbLogConfig = this.config.plugins.find(
        p => p.plugin === "DBLog" && p.enabled
      );
      if (!dbLogStatsConfig || !dbLogConfig) {
        logger.error(
          `[${this.name}] Both DBLogStats and DBLog plugins must be enabled for BasicStatsEmbed to function.`
        );
        return;
      }

      // Retrieve the DBLogStats table name.
      this.dbLogStatsTableName = dbLogStatsConfig.tableName;
      if (!this.dbLogStatsTableName) {
        logger.error(`[${this.name}] DBLogStats configuration is missing a tableName.`);
        return;
      }
      logger.info(`[${this.name}] Using DBLogStats table: ${this.dbLogStatsTableName}`);

      // Check that the required tables exist: "players" and the DBLogStats table.
      let [playersTable] = await process.mysqlPool.query("SHOW TABLES LIKE 'players'");
      if (!playersTable || playersTable.length === 0) {
        logger.error(`[${this.name}] Required table 'players' does not exist.`);
        return;
      }
      let [dbLogStatsTable] = await process.mysqlPool.query("SHOW TABLES LIKE ?", [this.dbLogStatsTableName]);
      if (!dbLogStatsTable || dbLogStatsTable.length === 0) {
        logger.error(`[${this.name}] Required table '${this.dbLogStatsTableName}' does not exist.`);
        return;
      }

      // Validate plugin configuration for BasicStatsEmbed.
      const pluginConfig = this.config.plugins.find(p => p.plugin === "BasicStatsEmbed");
      if (!pluginConfig || !pluginConfig.enabled) {
        logger.warn(`[${this.name}] Plugin is disabled in the configuration.`);
        return;
      }

      if (!pluginConfig.channel) {
        logger.error(`[${this.name}] No channel ID provided in the configuration.`);
        return;
      }
      this.channelId = pluginConfig.channel;

      // Fetch the guild and channel/thread.
      const guild = await this.discordClient.guilds.fetch(
        this.config.connectors.discord.guildId,
        { cache: true, force: true }
      );
      const channelOrThread = await guild.channels.fetch(this.channelId);
      if (!channelOrThread) {
        logger.error(`[${this.name}] Unable to find channel or thread with ID ${this.channelId}.`);
        return;
      }
      if (channelOrThread.isThread()) {
        this.channel = channelOrThread;
      } else if (channelOrThread.isTextBased()) {
        this.channel = channelOrThread;
      } else {
        logger.error(`[${this.name}] The specified channel is not a valid text channel or thread.`);
        return;
      }

      // Check bot permissions with a retry mechanism.
      const maxRetries = 3;
      let permissions = null;
      for (let i = 0; i < maxRetries; i++) {
        permissions = this.channel.permissionsFor(this.discordClient.user);
        if (permissions) break;
        logger.warn(`[${this.name}] Unable to determine bot permissions for the channel, retry ${i + 1} of ${maxRetries}.`);
        await new Promise(resolve => setTimeout(resolve, 1000)); // wait 1 second
      }
      if (!permissions) {
        logger.error(`[${this.name}] Unable to determine bot permissions for the channel after ${maxRetries} retries.`);
        return;
      }
      const requiredPermissions = ["ViewChannel", "SendMessages", "EmbedLinks"];
      const missingPermissions = requiredPermissions.filter(perm => !permissions.has(perm));
      if (missingPermissions.length > 0) {
        logger.error(
          `[${this.name}] Bot is missing the following permissions: ${missingPermissions.join(", ")}.`
        );
        return;
      }

      // Handle message ID: fetch the existing message if provided; otherwise, post a new embed.
      if (pluginConfig.messageID) {
        try {
          this.message = await this.channel.messages.fetch(pluginConfig.messageID);
        } catch (error) {
          logger.warn(
            `[${this.name}] Message with ID ${pluginConfig.messageID} not found. Posting a new one.`
          );
          this.message = await this.postInitialEmbed();
        }
      } else {
        this.message = await this.postInitialEmbed();
      }

      // Immediately update the embed so you don't have to wait for the first interval.
      await this.updateEmbed();

      // Start the update interval.
      const intervalMinutes = pluginConfig.interval || 5;
      this.interval = setInterval(() => this.updateEmbed(), intervalMinutes * 60 * 1000);
      logger.info(
        `[${this.name}] Initialized and started updating embed every ${intervalMinutes} minutes.`
      );
    } catch (error) {
      logger.error(`[${this.name}] Error during initialization: ${error.message}`);
    }
  }

  async postInitialEmbed() {
    try {
      const embed = new EmbedBuilder()
        .setTitle("ZSU Gaming Reforger Leaderboards")
        .setDescription(`All Time Stats - ${this.config.server.name}`)
        .setColor("#FFA500")
        // Add placeholder fields.
        .addFields(
          {
            name: "**Total Level Experience**",
            value: "Loading...",
            inline: true
          },
          {
            name: "**Most Kills**",
            value: "Loading...",
            inline: true
          },
          {
            name: "\u200B",
            value: "\u200B",
            inline: false
          },
          {
            name: "**Most Deaths**",
            value: "Loading...",
            inline: true
          },
          {
            name: "**Most Roadkills**",
            value: "Loading...",
            inline: true
          }
        );
      const message = await this.channel.send({ embeds: [embed] });
      logger.verbose(
        `[${this.name}] Posted initial embed with message ID: ${message.id}`
      );
      // Save the message ID to the config.
      const pluginConfig = this.config.plugins.find(p => p.plugin === "BasicStatsEmbed");
      if (pluginConfig) {
        pluginConfig.messageID = message.id;
        await this.saveConfig();
      }
      return message;
    } catch (error) {
      logger.error(`[${this.name}] Failed to post initial embed: ${error.message}`);
      throw error;
    }
  }

  async saveConfig() {
    try {
      const configPath = path.resolve(__dirname, "../../config.json");
      const updatedConfig = JSON.stringify(this.config, null, 2);
      fs.writeFileSync(configPath, updatedConfig, "utf8");
      logger.info(`[${this.name}] Configuration updated and saved.`);
    } catch (error) {
      logger.error(`[${this.name}] Failed to save configuration: ${error.message}`);
    }
  }

  async updateEmbed() {
    try {
      // Use the DBLogStats table (from config) for all stat queries.
      logger.verbose(`[${this.name}] Updating embed using DBLogStats table: ${this.dbLogStatsTableName}`);
      
      const [expResults] = await process.mysqlPool.query(
        `SELECT playerUID, level_experience FROM \`${this.dbLogStatsTableName}\` ORDER BY level_experience DESC LIMIT 10`
      );
      const [killsResults] = await process.mysqlPool.query(
        `SELECT playerUID, kills FROM \`${this.dbLogStatsTableName}\` ORDER BY kills DESC LIMIT 10`
      );
      const [deathsResults] = await process.mysqlPool.query(
        `SELECT playerUID, deaths FROM \`${this.dbLogStatsTableName}\` ORDER BY deaths DESC LIMIT 10`
      );
      const [roadkillsResults] = await process.mysqlPool.query(
        `SELECT playerUID, roadkills FROM \`${this.dbLogStatsTableName}\` ORDER BY roadkills DESC LIMIT 10`
      );

      // Helper: given a playerUID, look up the playerName from the "players" table.
      async function getPlayerName(playerUID) {
        try {
          const [rows] = await process.mysqlPool.query(
            `SELECT playerName FROM players WHERE playerUID = ?`,
            [playerUID]
          );
          if (rows.length > 0 && rows[0].playerName) {
            return rows[0].playerName;
          } else {
            return "Unknown";
          }
        } catch (error) {
          return "Unknown";
        }
      }

      // Helper: build a field string from a result set.
      async function buildFieldString(results, statKey, label) {
        let lines = [];
        let rank = 1;
        for (const row of results) {
          const playerUID = row.playerUID;
          const statValue = row[statKey];
          const playerName = await getPlayerName(playerUID);
          lines.push(`**#${rank}** - ${label}: ${statValue} - ${playerName}`);
          rank++;
        }
        return lines.join("\n");
      }

      const expField = await buildFieldString(expResults, "level_experience", "Points");
      const killsField = await buildFieldString(killsResults, "kills", "Kills");
      const deathsField = await buildFieldString(deathsResults, "deaths", "Deaths");
      let roadkillsField = await buildFieldString(roadkillsResults, "roadkills", "Kills");

      // Check embed field character limit (1024 characters per field for Discord).
      while (roadkillsField.length > 1024 && roadkillsResults.length > 0) {
        roadkillsResults.pop(); // Remove the last entry.
        roadkillsField = await buildFieldString(roadkillsResults, "roadkills", "Kills");
      }

      // Construct the embed.
      const embed = new EmbedBuilder()
        .setTitle("ZSU Gaming Reforger Leaderboards")
        .setDescription(`All Time Stats - ${this.config.server.name}`)
        .setColor("#FFA500")
        .addFields(
          { name: "**Total Level Experience**", value: expField || "No Data", inline: true },
          { name: "**Most Kills**", value: killsField || "No Data", inline: true },
          { name: "\u200B", value: "\u200B", inline: false },
          { name: "**Most Deaths**", value: deathsField || "No Data", inline: true },
          { name: "**Most Roadkills**", value: roadkillsField || "No Data", inline: true }
        );

      // Update the message embed.
      await this.message.edit({ embeds: [embed] });
      logger.verbose(`[${this.name}] Updated basic stats embed.`);
    } catch (error) {
      logger.error(`[${this.name}] Error updating embed: ${error.message}`);
    }
  }

  async cleanup() {
    logger.verbose(`[${this.name}] Cleaning up...`);
    if (this.interval) {
      clearInterval(this.interval);
      logger.verbose(`[${this.name}] Cleared update interval.`);
    }
    logger.info(`[${this.name}] Cleanup completed.`);
  }
}

module.exports = BasicStatsEmbed;
