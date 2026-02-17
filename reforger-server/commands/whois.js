const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('whois')
        .setDescription('Reforger player information')
        .addStringOption(option =>
            option
                .setName('identifier')
                .setDescription('The player identifier. Player name, BE GUID, Reforger ID, IP address, or Steam ID.')
                .setRequired(true)
        )
};