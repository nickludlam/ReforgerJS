const { EmbedBuilder, ActivityType } = require('discord.js');
const fs = require('fs');
const path = require('path');

class ServerStatus {
  constructor(config) {
    this.config = config;
    this.name = "ServerStatus Plugin";
    this.interval = null;
    this.isInitialized = false;
    this.serverInstance = null;
    this.discordClient = null;
    this.channel = null;
    this.message = null;
  }

  async prepareToMount(serverInstance, discordClient) {
    logger.verbose(`[${this.name}] Preparing to mount...`);
    this.serverInstance = serverInstance;
    this.discordClient = discordClient;

    try {
      // Validate plugin config for ServerStatus
      const pluginConfig = this.config.plugins.find(plugin => plugin.plugin === "ServerStatus");
      if (!pluginConfig || !pluginConfig.enabled) {
        logger.warn(`[${this.name}] Plugin is disabled in the configuration.`);
        return;
      }

      // Validate channel/thread ID
      if (!pluginConfig.channel) {
        logger.error(`[${this.name}] No channel or thread ID provided in the configuration.`);
        return;
      }
      this.channelId = pluginConfig.channel;

      // Fetch the guild and channel/thread
      const guild = await this.discordClient.guilds.fetch(this.config.connectors.discord.guildId, {
        cache: true,
        force: true,
      });
      const channelOrThread = await guild.channels.fetch(this.channelId);

      if (!channelOrThread) {
        logger.error(`[${this.name}] Unable to find channel or thread with ID ${this.channelId}.`);
        return;
      }

      // Determine if channel is a thread or text-based channel
      if (channelOrThread.isThread()) {
        this.channel = channelOrThread;
      } else if (channelOrThread.isTextBased()) {
        this.channel = channelOrThread;
      } else {
        logger.error(`[${this.name}] The specified ID is not a valid text channel or thread.`);
        return;
      }

      // Check bot permissions
      const permissions = this.channel.permissionsFor(this.discordClient.user);
      if (!permissions) {
        logger.error(`[${this.name}] Unable to determine bot permissions for the channel or thread.`);
        return;
      }
      const requiredPermissions = ["ViewChannel", "SendMessages", "EmbedLinks"];
      const missingPermissions = requiredPermissions.filter(perm => !permissions.has(perm));
      if (missingPermissions.length > 0) {
        logger.error(`[${this.name}] Bot is missing the following permissions: ${missingPermissions.join(", ")}.`);
        return;
      }

      // Handle message ID and post a new embed if necessary
      if (pluginConfig.messageID) {
        try {
          this.message = await this.channel.messages.fetch(pluginConfig.messageID);
        } catch (error) {
          logger.warn(`[${this.name}] Message with ID ${pluginConfig.messageID} not found. Posting a new one.`);
          this.message = await this.postInitialEmbed();
        }
      } else {
        this.message = await this.postInitialEmbed();
      }

      // Start the update interval (in minutes, defaulting to 1 minute)
      const intervalMinutes = pluginConfig.interval || 1;
      this.interval = setInterval(() => this.updateEmbed(), intervalMinutes * 60 * 1000);
      logger.info(`[${this.name}] Initialized and started updating every ${intervalMinutes} minute(s).`);
      this.isInitialized = true;
    } catch (error) {
      logger.error(`[${this.name}] Error during initialization: ${error.message}`);
    }
  }

  async postInitialEmbed() {
    try {
      const pluginConfig = this.config.plugins.find(plugin => plugin.plugin === "ServerStatus");
      const embedConfig = pluginConfig.embed || {};
      // Get the server name from config, defaulting to "Unknown" if not provided.
      const serverName = (this.config.server && this.config.server.name) ? this.config.server.name : "Unknown";

      const embed = new EmbedBuilder()
        .setTitle(embedConfig.title || "Server Status")
        .setColor(embedConfig.color || "#00FF00")
        // Use the server name as the embed description.
        .setDescription(serverName)
        .setTimestamp();

      if (embedConfig.footer) {
        embed.setFooter({ text: embedConfig.footer });
      }
      if (embedConfig.thumbnail && embedConfig.thumbnailURL && typeof embedConfig.thumbnailURL === "string" && embedConfig.thumbnailURL.trim().length > 0) {
        embed.setThumbnail(embedConfig.thumbnailURL);
      }

      // Optionally, add initial fields with placeholder values.
      embed.addFields(
        { name: "Player Count", value: "Loading...", inline: true },
        { name: "FPS", value: "Loading...", inline: true },
        { name: "Memory Usage", value: "Loading...", inline: true }
      );

      const message = await this.channel.send({ embeds: [embed] });
      logger.verbose(`[${this.name}] Posted initial embed with message ID: ${message.id}`);

      // Update plugin config with message ID and save the configuration
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
      const pluginConfig = this.config.plugins.find(plugin => plugin.plugin === "ServerStatus");
      const embedConfig = pluginConfig.embed || {};
      // Get the server name from config
      const serverName = (this.config.server && this.config.server.name) ? this.config.server.name : "Unknown";

      const embed = new EmbedBuilder()
        .setTitle(embedConfig.title || "Server Status")
        .setColor(embedConfig.color || "#00FF00")
        // Set the description to the server name
        .setDescription(serverName)
        .setTimestamp();

      if (embedConfig.footer) {
        embed.setFooter({ text: embedConfig.footer });
      }
      if (embedConfig.thumbnail && embedConfig.thumbnailURL && typeof embedConfig.thumbnailURL === "string" && embedConfig.thumbnailURL.trim().length > 0) {
        embed.setThumbnail(embedConfig.thumbnailURL);
      }

      // Gather the current stats from global values
      const playerCount = global.serverPlayerCount || 0;
      const fps = global.serverFPS || 0;
      const memoryUsageKB = global.serverMemoryUsage || 0;
      const memoryUsageMB = (memoryUsageKB / 1024).toFixed(2);

      // Add the inline fields for Player Count, FPS, and Memory Usage.
      embed.addFields(
        { name: "Player Count", value: `${playerCount}`, inline: true },
        { name: "FPS", value: `${fps}`, inline: true },
        { name: "Memory Usage", value: `${memoryUsageMB} MB`, inline: true }
      );

      // Edit the original message with the updated embed.
      await this.message.edit({ embeds: [embed] });
      logger.verbose(`[${this.name}] Updated server status embed.`);

      // If the discordBotStatus option is enabled, update the bot's presence.
      if (pluginConfig.discordBotStatus && this.discordClient && this.discordClient.user) {
        const newStatus = `📢${playerCount} Players | ${fps} FPS`;
        try {
          // Update bot presence without chaining .then()
          this.discordClient.user.setActivity({
            type: ActivityType.Custom,
            name: newStatus,
            state: newStatus,
          });
          logger.verbose(`[${this.name}] Updated Discord bot status to: ${newStatus}`);
        } catch (error) {
          logger.error(`[${this.name}] Error updating bot status: ${error.message}`);
        }
      }
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

module.exports = ServerStatus;
