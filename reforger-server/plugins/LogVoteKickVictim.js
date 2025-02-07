const { EmbedBuilder } = require('discord.js');

class LogVoteKickVictim {
    constructor(config) {
        this.config = config;
        this.name = 'LogVoteKickVictim Plugin';
        this.serverInstance = null;
        this.discordClient = null;
        this.channelOrThread = null;
        this.channelId = null;
    }

    // Helper function to create a delay
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Retry mechanism to check if the bot has all required permissions
    async checkPermissionsWithRetry(channel, user, requiredPermissions, retries = 3, delayMs = 1000) {
        for (let i = 0; i < retries; i++) {
            const perms = channel.permissionsFor(user);
            if (perms && requiredPermissions.every(perm => perms.has(perm))) {
                return true;
            }
            await this.delay(delayMs);
        }
        return false;
    }

    async prepareToMount(serverInstance, discordClient) {
        logger.verbose(`[${this.name}] Preparing to mount...`);
        this.serverInstance = serverInstance;
        this.discordClient = discordClient;

        try {
            // Check if the channel option is present in the config
            const pluginConfig = this.config.plugins.find(plugin => plugin.plugin === 'LogVoteKickVictim');
            if (!pluginConfig || !pluginConfig.channel) {
                logger.warn(`[${this.name}] Missing 'channel' ID in plugin config. Plugin disabled.`);
                return;
            }

            this.channelId = pluginConfig.channel;

            // Fetch the Discord guild and channel/thread
            const guild = await this.discordClient.guilds.fetch(this.config.connectors.discord.guildId, {
                cache: true,
                force: true,
            });
            const channelOrThread = await guild.channels.fetch(this.channelId);

            if (!channelOrThread) {
                logger.warn(`[${this.name}] Unable to find channel or thread with ID ${this.channelId}. Plugin disabled.`);
                return;
            }

            // Check if the target is a thread or a regular text channel
            if (channelOrThread.isThread()) {
                this.channelOrThread = channelOrThread;
            } else if (channelOrThread.isTextBased()) {
                this.channelOrThread = channelOrThread;
            } else {
                logger.warn(`[${this.name}] The specified ID is not a valid text channel or thread. Plugin disabled.`);
                return;
            }

            // Define required permissions
            const requiredPermissions = ['ViewChannel', 'SendMessages', 'EmbedLinks'];
            // Use the retry mechanism to check for permissions
            const hasPermissions = await this.checkPermissionsWithRetry(
                this.channelOrThread,
                this.discordClient.user,
                requiredPermissions
            );

            if (!hasPermissions) {
                const perms = this.channelOrThread.permissionsFor(this.discordClient.user);
                if (!perms) {
                    logger.error(`[${this.name}] Unable to determine bot permissions for the channel or thread.`);
                } else {
                    const missingPermissions = requiredPermissions.filter(perm => !perms.has(perm));
                    logger.error(`[${this.name}] Bot is missing the following permissions in the channel or thread: ${missingPermissions.join(', ')}.`);
                }
                return;
            }

            // Listen for the 'voteKickVictim' event
            this.serverInstance.on('voteKickVictim', async (data) => {
                await this.handleVoteKickVictim(data);
            });

            logger.info(`[${this.name}] Initialized and listening for 'voteKickVictim' events.`);
        } catch (error) {
            logger.error(`[${this.name}] Error during preparation: ${error.message}`);
        }
    }

    async handleVoteKickVictim(data) {
        const { playerName, group, reason, playerUID } = data;

        const embed = new EmbedBuilder()
            .setTitle('Player has been Vote Kicked')
            .setDescription(`**Server:** ${this.config.server.name}\n\n**Player:** ${playerName}`)
            .setColor('#FFA500')
            .setFooter({
                text: 'VoteKickVictim plugin - ZSUGaming ReforgerJS',
            });

        // Add UID to the embed if present
        if (playerUID) {
            embed.addFields({
                name: 'Player UID',
                value: playerUID,
                inline: false
            });
        }

        try {
            await this.channelOrThread.send({ embeds: [embed] });
            logger.info(`[${this.name}] Vote kick logged for player '${playerName}'${playerUID ? ` (UID: ${playerUID})` : ''}.`);
        } catch (error) {
            logger.error(`[${this.name}] Failed to send embed: ${error.message}`);
        }
    }
}

module.exports = LogVoteKickVictim;
