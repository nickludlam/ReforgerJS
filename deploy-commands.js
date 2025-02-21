const { REST } = require('@discordjs/rest');
const { Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const logger = require('./reforger-server/logger/logger');

function loadConfig(filePath) {
    try {
        const rawData = fs.readFileSync(filePath, 'utf8');
        if (!rawData) {
            throw new Error('Config file is empty.');
        }
        return JSON.parse(rawData);
    } catch (error) {
        logger.error(`Error reading config file: ${error.message}`);
        process.exit(1);
    }
}

function validateConfig(config) {
    if (typeof config !== 'object' || config === null) {
        logger.error('Config is not a valid JSON object.');
        process.exit(1);
    }
    if (!config.connectors || !config.connectors.discord) {
        logger.error('Discord connector configuration is missing in the config.');
        process.exit(1);
    }
    const discordConfig = config.connectors.discord;
    if (!discordConfig.token || !discordConfig.clientId || !discordConfig.guildId) {
        logger.error('Discord token, clientId, or guildId is missing in the config.');
        process.exit(1);
    }
    if (!config.commands || !Array.isArray(config.commands)) {
        logger.error('Commands configuration is missing or not an array in the config.');
        process.exit(1);
    }
}

(async () => {
    const configPath = path.resolve(__dirname, './config.json');
    const config = loadConfig(configPath);
    validateConfig(config);

    const rest = new REST({ version: '10' }).setToken(config.connectors.discord.token);

    try {
        logger.info('Clearing existing commands...');
        await rest.put(
            Routes.applicationGuildCommands(config.connectors.discord.clientId, config.connectors.discord.guildId),
            { body: [] }
        );
        logger.info('Successfully cleared existing commands.');

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

        logger.info('Deploying commands...');
        await rest.put(
            Routes.applicationGuildCommands(config.connectors.discord.clientId, config.connectors.discord.guildId),
            { body: commands }
        );
        logger.info('Successfully deployed commands.');
    } catch (error) {
        logger.error(`Error deploying commands: ${error.message}`);
    }

    process.exit(0);
})();
