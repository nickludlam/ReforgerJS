const { EmbedBuilder } = require('discord.js');

class LogVoteKickStart {
    constructor(config) {
        this.config = config;
        this.name = 'LogVoteKickStart Plugin';
        this.serverInstance = null;
        this.discordClient = null;
        this.channelOrThread = null;
        this.channelId = null;
    }

    async prepareToMount(serverInstance, discordClient) {
        logger.verbose(`[${this.name}] Preparing to mount...`);
        this.serverInstance = serverInstance;
        this.discordClient = discordClient;

        try {
            // Check if the channel/thread ID is present in the config
            const pluginConfig = this.config.plugins.find(plugin => plugin.plugin === 'LogVoteKickStart');
            if (!pluginConfig || !pluginConfig.channel) {
                logger.warn(`[${this.name}] Missing 'channel' ID in plugin config. Plugin disabled.`);
                return;
            }

            this.channelId = pluginConfig.channel;

            // Fetch the guild and check if the channel ID corresponds to a channel or thread
            const guild = await this.discordClient.guilds.fetch(this.config.connectors.discord.guildId, {
                cache: true,
                force: true
            });

            const channelOrThread = await guild.channels.fetch(this.channelId);
            if (!channelOrThread) {
                logger.warn(`[${this.name}] Unable to find channel or thread with ID ${this.channelId}. Plugin disabled.`);
                return;
            }

            // Check if the target is a thread or a regular channel
            if (channelOrThread.isThread()) {
                this.channelOrThread = channelOrThread;
            } else if (channelOrThread.isTextBased()) {
                this.channelOrThread = channelOrThread;
            } else {
                logger.warn(`[${this.name}] The specified ID is not a valid text channel or thread. Plugin disabled.`);
                return;
            }

            // Check if the bot has permission to send messages
            if (!this.channelOrThread.permissionsFor(this.discordClient.user).has('SendMessages')) {
                logger.warn(`[${this.name}] Bot does not have permission to send messages in the channel or thread. Plugin disabled.`);
                return;
            }

            // Listen for the 'voteKickStart' event
            this.serverInstance.on('voteKickStart', async (data) => {
                await this.handleVoteKickStart(data);
            });

            logger.info(`[${this.name}] Initialized and listening for 'voteKickStart' events.`);
        } catch (error) {
            logger.error(`[${this.name}] Error during preparation: ${error.message}`);
        }
    }

    async handleVoteKickStart(data) {
        const { playerName, playerId } = data;

        // Check if playerName exists in the data
        if (!playerName) {
            logger.verbose(`[${this.name}] Missing 'playerName' in voteKickStart data. Event ignored.`);
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle('Player has initiated a vote kick!')
            .setDescription(`**Server:** ${this.config.server.name}\n\n**Player:** ${playerName}\n**PlayerID:** ${playerId}`)
            .setColor('#FFA500')
            .setFooter({
                text: 'VoteKickStart plugin - ZSUGaming ReforgerJS',
            });

        try {
            await this.channelOrThread.send({ embeds: [embed] });
            logger.info(`[${this.name}] Vote kick started by player '${playerName}' (ID: ${playerId}) logged.`);
        } catch (error) {
            logger.error(`[${this.name}] Failed to send embed: ${error.message}`);
        }
    }
}

module.exports = LogVoteKickStart;