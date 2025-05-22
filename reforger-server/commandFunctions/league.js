const { EmbedBuilder } = require('discord.js');
const mysql = require('mysql2/promise');
const { escapeMarkdown } = require('../../helpers');
const EXDLeague = require('../plugins/EXDLeague');

module.exports = async (interaction, serverInstance, discordClient, extraData = {}) => {
    const user = interaction.user;
    const subcommand = interaction.options.getSubcommand();
    console.log(`[League Command] User: ${user.username} (ID: ${user.id}) requested subcommand: ${subcommand}`);

    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true });
    }

    try {
        const pool = process.mysqlPool || serverInstance.mysqlPool;
        if (!pool) {
            await interaction.editReply('Database connection is not initialized.');
            return;
        }

        // Get the instance of the plugin 'EXDLeague'
        const pluginInstance = serverInstance.pluginInstances.find((plugin) => plugin instanceof EXDLeague);
        if (!pluginInstance) {
            await interaction.editReply('EXDLeague plugin is not loaded.');
            return;
        }

        logger.verbose(`[League Command] subcommand ${subcommand}`);

        if (subcommand === 'start') {
            // call startNewLeague
            await pluginInstance.startNewLeague();
            await interaction.editReply('New league started.');
        } else if (subcommand === 'report') {
            const readableStatName = new Map([
                ['diff_kills', 'Kills'],
                ['diff_ai_kills', 'AI Kills'],
                ['diff_deaths', 'Deaths'],
                ['kd_ratio', 'KD Ratio'],
                ['diff_friendly_kills', 'Friendly kills'],
                ['diff_distance_driven', 'Distance driven'],
                ['diff_distance_walked', 'Distance walked'],
                ['minutes_played_in_league', 'Minutes played'],
                ['total_medical', 'Team Medic']
            ]);

            const stat = interaction.options.getString('stat', true);
            const statName = readableStatName.get(stat);
            const resultCount = 10;

            const results = await pluginInstance.getLeagueStatsDiff(resultCount, stat);
            if (!results) {
                await interaction.editReply('No league is currently running.');
                return;
            }

            // Build a compact leaderboard string
            let leaderboard = '';
            if (results && results.players) {
                leaderboard = results.players.map((player, index) => {
                    let medal = '';
                    if (index === 0) medal = `#${index + 1} 🥇`;
                    else if (index === 1) medal = `#${index + 1} 🥈`;
                    else if (index === 2) medal = `#${index + 1} 🥉`;
                    else medal = `#${index + 1} `;

                    const value = typeof player[stat] === 'number'
                        ? (Number.isInteger(player[stat])
                            ? player[stat].toString()
                            : Number(player[stat]).toFixed(1))
                        : player[stat];

                    return `${medal}${escapeMarkdown(player.playerName)} — **${value}**`;
                }).join('\n');
            } else {
                leaderboard = 'No results found.';
            }

            const formattedStartDate = new Date(results.league.startDate).toLocaleDateString('en-GB', {
                weekday: 'short',
                day: '2-digit',
                month: 'short',
                year: 'numeric'
            });

            const embed = new EmbedBuilder()
                .setTitle(`🏆 Top ${resultCount} ${statName} 🏆`)
                .setDescription(
                    `League ${results.league.number} started on ${formattedStartDate} with ${results.league.totalParticipants} players.\n\n${leaderboard}`
                )
                .setColor(0x0099FF);

            await interaction.editReply({ embeds: [embed] });
        } else if (subcommand === 'wipe') {
            // call wipeLeagueStats
            await pluginInstance.wipeAllLeagueStats();
            await interaction.editReply('League stats wiped.');        
        }
    }
    catch (error) {
        console.error('Error in league command:', error);
        return;
    }
}


