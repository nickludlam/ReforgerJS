const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('league')
        .setDescription('EXD League functions')
        .addSubcommand(subcommand =>
            subcommand
                .setName('start')
                .setDescription('Start a new league and reset the stats')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('report')
                .setDescription('Gets all the stats for the players in the league')
                // add multiple choices for the stats
                .addStringOption(option =>
                    option
                        .setName('stat')
                        .setDescription('The stat to get')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Kills', value: 'diff_kills' },
                            { name: 'AI Kills', value: 'diff_ai_kills' },
                            { name: 'Deaths', value: 'diff_deaths' },
                            { name: 'KD Ratio', value: 'kd_ratio' },
                            { name: 'Medical actions', value: 'total_medical' },
                            { name: 'Friendly kills', value: 'diff_friendly_kills' },
                            { name: 'Distance driven', value: 'diff_distance_driven' },
                            { name: 'Distance walked', value: 'diff_distance_walked' },
                            { name: 'Minutes played', value: 'minutes_played_in_league' }
                        )
                )
                // Add an optional identifier for the player
                .addStringOption(option =>
                    option
                        .setName('identifier')
                        .setDescription('An optional identifier of a player to look up')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('wipe')
                .setDescription('Wipe all league stats')
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('debuginfo')
                .setDescription('Get debug information about the current league')
                .addStringOption(option =>
                    option
                        .setName('identifier')
                        .setDescription('An optional identifier of a player to look up (Reforger UUID or Name)')
                        .setRequired(false)
                )
        ),
}