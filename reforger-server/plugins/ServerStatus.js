const { queryGameServerInfo } = require('steam-server-query');
const { EmbedBuilder, AttachmentBuilder, ActivityType } = require('discord.js');
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
    this.a2sAddress = null;
    this.a2sPort = null;
    
    this.imageAlreadySet = false; // Track if the image has already been set in the embed
  }

  async prepareToMount(serverInstance, discordClient) {
    await this.cleanup();
    this.serverInstance = serverInstance;
    this.discordClient = discordClient;

    this.a2sAddress = this.config.server.host;
    if (!this.a2sAddress || !this.a2sAddress.trim()) {
      logger.error("ServerStatus plugin: Config entry 'server.address' is not configured or empty");
      return;
    }
    this.a2sPort = this.config.server.a2sPort;
    if (!this.a2sPort || isNaN(this.a2sPort)) {
      logger.error("ServerStatus plugin: Config entry 'server.a2sPort' is not configured correctly or is not a number");
      return;
    }

    try {
      const pluginConfig = this.config.plugins.find(plugin => plugin.plugin === "ServerStatus");
      if (!pluginConfig?.enabled || !pluginConfig?.channel) {
        logger.verbose("ServerStatus plugin is disabled or missing channel configuration");
        return;
      }

      this.channelId = pluginConfig.channel;
      logger.verbose(`ServerStatus initializing with channel ID: ${this.channelId}`);
      
      const guild = await this.discordClient.guilds.fetch(this.config.connectors.discord.guildId, { cache: true, force: true });
      this.channel = await guild.channels.fetch(this.channelId);

      if (!this.channel?.isTextBased()) {
        logger.error(`ServerStatus plugin: Channel ${this.channelId} is not a text channel`);
        return;
      }

      const permissions = this.channel.permissionsFor(this.discordClient.user);
      if (!permissions?.has(["ViewChannel", "SendMessages", "EmbedLinks"])) {
        logger.error(`ServerStatus plugin: Missing required permissions in channel ${this.channelId}`);
        return;
      }

      if (pluginConfig.messageID) {
        try {
          logger.verbose(`ServerStatus plugin: Attempting to fetch existing message ${pluginConfig.messageID}`);
          this.message = await this.channel.messages.fetch(pluginConfig.messageID);
        // eslint-disable-next-line no-unused-vars
        } catch (error) {
          logger.info(`ServerStatus plugin: Could not fetch existing message, creating a new one`);
          this.message = await this.postInitialEmbed();
        }
      } else {
        logger.verbose(`ServerStatus plugin: No message ID configured, creating initial embed`);
        this.message = await this.postInitialEmbed();
      }

      this.interval = setInterval(() => this.updateEmbed(), (pluginConfig.interval || 1) * 60 * 1000);
      logger.info(`ServerStatus plugin: Initialized with update interval of ${pluginConfig.interval || 1} minutes`);
      this.isInitialized = true;
    } catch (error) {
      logger.error(`ServerStatus plugin: Error during initialization: ${error.message}`);
    }
  }

  tryCreateAttachmentFromPath() {
    if (this.imageAlreadySet) {
      return null; // If the image has already been set, skip creating a new attachment
    }

    const pluginConfig = this.config.plugins.find(plugin => plugin.plugin === "ServerStatus");
    const embedConfig = pluginConfig.embed || {};
    if (embedConfig.image && embedConfig.imagePath) {
      const configImagePath = embedConfig.imagePath;
      if (configImagePath.startsWith("/")) {
        // Treat images starting with '/' as paths relative to the project root, and strip it off
        const relativePath = configImagePath.startsWith("/") ? configImagePath.slice(1) : configImagePath;
        const fullImagePath = path.resolve(__dirname, "../../", relativePath);
        return new AttachmentBuilder(fullImagePath);
      }
    }
    return null;
  }

  async postInitialEmbed() {
    try {
      const pluginConfig = this.config.plugins.find(plugin => plugin.plugin === "ServerStatus");
      const embedConfig = pluginConfig.embed || {};
      const serverName = this.config.server?.name || "Unknown";

      let attachment = this.tryCreateAttachmentFromPath();

      const fields = [
        { name: "Player Count", value: "Loading...", inline: true },
        { name: "Scenario", value: "Loading...", inline: true },
        { name: "FPS", value: "Loading...", inline: true },
        { name: "Memory Usage", value: "Loading...", inline: true }
      ]

      const embed = new EmbedBuilder()
        .setTitle(embedConfig.title || serverName || "Server Status")
        .setColor(embedConfig.color || "#00FF00")
        .setTimestamp()
        .addFields(fields);

      if (attachment || this.imageAlreadySet) {
        embed.setImage(`attachment://${path.basename(embedConfig.imagePath)}`);
      }
      
      if (embedConfig.footer) embed.setFooter({ text: embedConfig.footer });
      
      // Only set thumbnail if thumbnail is not explicitly set to false and a URL is provided
      if (embedConfig.thumbnail !== false && embedConfig.thumbnailURL?.trim()) {
        logger.verbose(`ServerStatus plugin: Setting thumbnail to ${embedConfig.thumbnailURL}`);
        embed.setThumbnail(embedConfig.thumbnailURL);
      } else {
        logger.verbose(`ServerStatus plugin: Thumbnail is disabled or URL not provided`);
      }
      const payload = { embeds: [embed] };
      if (attachment) {
        payload.files = [attachment];
        this.imageAlreadySet = true; // Mark that the image has been set
      }
      const message = await this.channel.send(payload);
      pluginConfig.messageID = message.id;
      await this.saveConfig();
      logger.info(`ServerStatus plugin: Initial embed posted with message ID: ${message.id}`);

      return message;
    } catch (error) {
      logger.error(`ServerStatus plugin: Error posting initial embed: ${error.message}`);
      throw error;
    }
  }

  async saveConfig() {
    try {
      const configPath = path.resolve(__dirname, "../../config.json");
      fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2), "utf8");
      logger.verbose(`ServerStatus plugin: Config saved with updated message ID`);
    } catch (error) {
      logger.error(`ServerStatus plugin: Error saving config: ${error.message}`);
    }
  }

  async updateEmbed() {
    try {
      const pluginConfig = this.config.plugins.find(plugin => plugin.plugin === "ServerStatus");
      const embedConfig = pluginConfig.embed || {};
      const serverName = this.config.server?.name || "Unknown";

      const playerCount = global.serverPlayerCount || 0;
      const fps = global.serverFPS || 0;
      const memoryUsageMB = ((global.serverMemoryUsage || 0) / 1024).toFixed(2);

      // Now use A2S to get the map name
      var mapName = "Unknown Scenario";
      const a2sInfo = await this.runA2SQuery(this.a2sAddress, this.a2sPort);
      if (a2sInfo) {
        mapName = a2sInfo.map || "Unknown Scenario";
      }

      let attachment = this.tryCreateAttachmentFromPath();

      const haveServerDataUpdateTime = global.serverDataLastUpdatedAt && !isNaN(global.serverDataLastUpdatedAt);
      const lastUpdatedAt = global.serverDataLastUpdatedAt || new Date();
      const secondsSinceLastUpdate = Math.floor((Date.now() - lastUpdatedAt) / 1000);
      const dynamicEmbedColor = secondsSinceLastUpdate < 60 ? "#00FF00" : "#FF0000";

      const fields = [
        { name: "Player Count", value: `${playerCount}`, inline: true },
        { name: "Scenario", value: mapName, inline: true },
        { name: "FPS", value: `${fps}`, inline: true },
        { name: "Memory Usage", value: `${memoryUsageMB} MB`, inline: true },
      ]

      if (global.serverLastGameStartTime) {
        // Format the elapsed time since the last game start
        const elapsedTime = Date.now() - global.serverLastGameStartTime;
        const minutes = Math.floor((elapsedTime / (1000 * 60)) % 60);
        const hours = Math.floor((elapsedTime / (1000 * 60 * 60)));
        const formattedTime = `${hours}h ${minutes}m`;
        fields.push({ name: "Current game duration", value: formattedTime, inline: true });
      }

      if (haveServerDataUpdateTime) {
        fields.push({ name: "Server replied", value: `${secondsSinceLastUpdate} seconds ago`, inline: true });
      }

      const embed = new EmbedBuilder()
        .setTitle(embedConfig.title || serverName || "Server Status")
        .setColor(dynamicEmbedColor)
        .setTimestamp()
        .addFields(fields);

      if (attachment || this.imageAlreadySet) {
        embed.setImage(`attachment://${path.basename(embedConfig.imagePath)}`);
      }

      if (embedConfig.footer) embed.setFooter({ text: embedConfig.footer });
      
      // Only set thumbnail if thumbnail is not explicitly set to false and a URL is provided
      if (embedConfig.thumbnail !== false && embedConfig.thumbnailURL?.trim()) {
        // logger.verbose(`ServerStatus plugin: Setting thumbnail to ${embedConfig.thumbnailURL}`);
        embed.setThumbnail(embedConfig.thumbnailURL);
      }

      const payload = { embeds: [embed] };
      if (attachment) {
        payload.files = [attachment];
        this.imageAlreadySet = true; // Mark that the image has been set
      }

      await this.message.edit(payload);
      logger.verbose(`ServerStatus plugin: Embed updated with ${playerCount} players, ${fps} FPS, ${memoryUsageMB} MB memory usage`);

      if (pluginConfig.discordBotStatus && this.discordClient?.user) {
        this.discordClient.user.setActivity({
          type: ActivityType.Custom,
          name: `📢${playerCount} Players | ${fps} FPS`,
          state: `📢${playerCount} Players | ${fps} FPS`,
        });
        // logger.verbose(`ServerStatus plugin: Discord bot status updated`);
      }
    } catch (error) {
      logger.error(`ServerStatus plugin: Error updating embed: ${error.message}`);
    }
  }

  async cleanup() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.verbose(`ServerStatus plugin: Cleanup - interval cleared`);
    }
    this.serverInstance = null;
    this.discordClient = null;
    this.channel = null;
    this.message = null;
    logger.verbose(`ServerStatus plugin: Cleanup complete`);
  }

  async runA2SQuery(ip, port) {
  // Example return from queryGameServerInfo
  // {
  //   protocol: 0,
  //   name: '#1 EXD.gg » 1st Person | New Player Friendly | EU | Vanilla | Discord.exd.gg',
  //   map: 'Conflict - Everon No Relays - 6 Cap',
  //   folder: '',
  //   game: 'Arma Reforger',
  //   appId: 0,
  //   players: 22,
  //   maxPlayers: 110,
  //   bots: 0,
  //   serverType: 'd',
  //   environment: 'l',
  //   visibility: 0,
  //   vac: 0,
  //   version: '1.4.0.38',
  //   port: -15605,
  //   keywords: '',
  //   game
  // }

  const serverAddress = `${ip}:${port}`;
  try {
    const infoResponse = await queryGameServerInfo(serverAddress);
    return {
      name: infoResponse.name,
      map: infoResponse.map,
      players: infoResponse.players,
      maxPlayers: infoResponse.maxPlayers,
      version: infoResponse.version,
    };
  } catch (err) {
    logger.error(`[A2S Query] Error querying server ${serverAddress}: ${err.message}`);
    return null;
  }
}

}

module.exports = ServerStatus;
