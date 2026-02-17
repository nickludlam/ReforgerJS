const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('voteinfo')
        .setDescription('Retrieve player vote statistics by Reforger ID')
        .addStringOption(option =>
            option
                .setName('reforgerid')
                .setDescription('The Reforger ID of the player')
                .setRequired(true)
        )
};