const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Retrieve player statistics by UUID')
        .addStringOption(option =>
            option
                .setName('uuid')
                .setDescription('The UUID of the player')
                .setRequired(true)
        )
};