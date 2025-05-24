const logger = require("./logger/logger");

class CommandHandler {
    constructor(config, serverInstance, discordClient) {
        this.config = config;
        this.serverInstance = serverInstance;
        this.discordClient = discordClient;
    }

    async initialize() {
        if (!this.config || !this.config.commands || !this.config.roleLevels || !this.config.roles) {
            throw new Error('CommandHandler configuration is missing required fields.');
        }

        logger.info('CommandHandler initialized successfully.');
    }

    async handleCommand(interaction, extraData = {}) {
        if (!interaction.isCommand()) return;
    
        const commandName = interaction.commandName;
        const commandConfig = this.config.commands.find(cmd => cmd.command === commandName);
        
        if (!commandConfig || !commandConfig.enabled) {
            logger.info(`Command '${commandName}' is disabled in this instance. Ignoring.`);
            return;
        }
    
        const commandLevel = commandConfig.commandLevel;
        let subCommandLevel = 0; // assume no subcommand

        // Get any optional subcommand - we need to check both the command and subcommand
        const subcommand = interaction.options.getSubcommand(false);
        if (subcommand) {
          // If we have a subcommand, check for a string match in the command config, and cast it to a number
          const subCommandConfig = commandConfig[subcommand];
          if (subCommandConfig) {
            subCommandLevel = parseInt(subCommandConfig, 10);
          }
        }

        // COMMAND LEVEL | SUBCOMMAND LEVEL | RESULT
        // 0            | 0                | No permission check
        // 0            | 1                | Check subcommand level
        // 1            | 0                | Check command level
        // 1            | 1                | Check command level and subcommand level

        if (commandLevel > 0 || subCommandLevel > 0) {
            // Ok we need to check something ...
            const userRoles = interaction.member.roles.cache.map(role => role.id);
            const allowedRoles = [];;
            if (commandLevel > 0) {
                // Check the command level
                allowedRoles.push(...this.getAllowedRolesForLevel(commandLevel));
            }
            if (subCommandLevel > 0) {
                // Check the subcommand level
                allowedRoles.push(...this.getAllowedRolesForLevel(subCommandLevel));
            }

            if (!this.userHasPermission(userRoles, new Set(allowedRoles))) {
                await interaction.reply({
                    content: 'You do not have permission to use this command.',
                    ephemeral: true
                });
                return;
            }
        }
    
        try {
            extraData.commandConfig = commandConfig;
            const commandFunction = require(`./commandFunctions/${commandName}`);
            await commandFunction(interaction, this.serverInstance, this.discordClient, extraData);
        } catch (error) {
            logger.error(`Error executing command '${commandName}': ${error.message}`);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: 'An error occurred while executing the command.',
                    ephemeral: true
                });
            } else if (interaction.deferred && !interaction.replied) {
                await interaction.editReply({
                    content: 'An error occurred while executing the command.'
                });
            }
        }
    }

    getAllowedRolesForLevel(level) {
        const roleLevels = this.config.roleLevels;
        const allowedRolesSet = new Set();

        for (const [key, roles] of Object.entries(roleLevels)) {
            if (parseInt(key, 10) <= level) {
                roles.forEach(role => {
                    if (this.config.roles[role]) {
                        allowedRolesSet.add(this.config.roles[role]);
                    }
                });
            }
        }

        return Array.from(allowedRolesSet);
    }

    userHasPermission(userRoles, rolesSet) {
        logger.verbose(`Checking user roles: ${userRoles} against allowed roles: ${Array.from(rolesSet)}`);
        return userRoles.some(role => rolesSet.has(role));
    }

    async cleanup() {
        logger.info('CommandHandler cleanup completed.');
    }
}

module.exports = CommandHandler;
