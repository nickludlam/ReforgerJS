const { REST } = require('@discordjs/rest');
const { Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const logger = require('./reforger-server/logger/logger');

// Load config
function loadConfig(filePath) {
    try {
        const rawData = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(rawData);
    } catch (error) {
        logger.error(`Error reading config file: ${error.message}`);
        process.exit(1);
    }
}

(async () => {
    const configPath = path.resolve(__dirname, './config.json');
    const config = loadConfig(configPath);

    if (!config.connectors.discord || !config.connectors.discord.token || !config.connectors.discord.clientId || !config.connectors.discord.guildId) {
        logger.error('Discord token, clientId, or guildId is missing in the config.');
        process.exit(1);
    }

    const rest = new REST({ version: '10' }).setToken(config.connectors.discord.token);

    try {
        // Clear existing commands
        logger.info('Clearing existing commands...');
        await rest.put(Routes.applicationGuildCommands(config.connectors.discord.clientId, config.connectors.discord.guildId), { body: [] });
        logger.info('Successfully cleared existing commands.');

        // Load all commands from the commands directory
        const commandsPath = path.resolve(__dirname, './reforger-server/commands');
        const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
        const commands = [];

        for (const file of commandFiles) {
            const command = require(path.join(commandsPath, file));

            const commandConfig = config.commands.find(cmd => cmd.command === command.data.name);
            if (commandConfig && commandConfig.enabled) {
                commands.push(command.data.toJSON());
                logger.info(`Command '/${command.data.name}' loaded.`);
            } else {
                logger.info(`Command '/${command.data.name}' is disabled in the config and will not be loaded.`);
            }
        }

        // Deploy new commands
        logger.info('Deploying commands...');
        await rest.put(
            Routes.applicationGuildCommands(config.connectors.discord.clientId, config.connectors.discord.guildId),
            { body: commands }
        );
        logger.info('Successfully deployed commands.');
    } catch (error) {
        logger.error(`Error deploying commands: ${error.message}`);
    }

    // Exit process
    process.exit(0);
})();
