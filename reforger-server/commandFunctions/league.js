const { EmbedBuilder } = require('discord.js');
const { escapeMarkdown } = require('../../helpers');
const EXDLeague = require('../plugins/EXDLeague');

// eslint-disable-next-line no-unused-vars
module.exports = async (interaction, serverInstance, discordClient, extraData = {}) => {
    const user = interaction.user;
    const subcommand = interaction.options.getSubcommand();
    logger.verbose(`[League Command] User: ${user.username} (ID: ${user.id}) requested subcommand: ${subcommand}`);

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

        if (subcommand === 'start') {
            // call startNewLeague
            await pluginInstance.startNewLeague();
            await interaction.editReply('New league started.');
        } else if (subcommand === 'report') {
            // get the optional identifier
            let playerUID = null;
            const identifier = interaction.options.getString('identifier', false);
            if (identifier) {
              const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
              if (!isUUID) {
                const playerUIDResult = await pluginInstance.getPlayerUIDByName(identifier);
                if (!playerUIDResult) {
                    await interaction.editReply(`Cannot find single match with name: ${identifier}`);
                    return;
                }
                playerUID = playerUIDResult;
              } else {
                playerUID = identifier;
              }
            }
                      
            const readableStatName = new Map([
                ['diff_kills', 'kills'],
                ['diff_ai_kills', 'AI kills'],
                ['diff_deaths', 'deaths'],
                ['kd_ratio', 'KD ratio'],
                ['diff_friendly_kills', 'friendly kills'],
                ['diff_distance_driven', 'distance driven'],
                ['diff_distance_walked', 'distance walked'],
                ['minutes_played_in_league', 'minutes played'],
                ['total_medical', 'team medic']
            ]);

            const distance_stats = ['diff_distance_driven', 'diff_distance_walked'];

            const stat = interaction.options.getString('stat', true);
            const statName = readableStatName.get(stat);
            const resultCount = playerUID ? 7 : 10;

            const results = await pluginInstance.getLeagueStatsDiff(playerUID, resultCount, stat);
            if (!results) {
                await interaction.editReply('No league is currently running.');
                return;
            }

            let requestedPlayerInResults = false;
            let requestedPlayerName = '';
            let totalPlayerCount = results.league.totalEntrantCount;
            // If we have a playerUID, we report back less players
            if (results.requestedPlayer) {
                totalPlayerCount = results.requestedPlayer.totalPlayerCount;
            }


            // Account for the offset if we have a requested player

            let offset = 0;
            if (results.requestedPlayer) {
              // Check if the requestedPlayer is present in the results
              const requestedPlayer = results.players.find(player => player.playerUID === results.requestedPlayer.uid);
              if (requestedPlayer) {
                // Get the index of the requestedPlayer in the players list
                const requestedPlayerIndex = results.players.indexOf(requestedPlayer);
                // Calculate the offset.  e.g. if the index is 3, and requestedPlayer.position is 43, we need to add 40 to the index
                offset = results.requestedPlayer.position - requestedPlayerIndex - 1; // An additional -1 because the index is 0-based
                requestedPlayerInResults = true;
                requestedPlayerName = results.players[requestedPlayerIndex].playerName;
              }
            }


            // Build a compact leaderboard string
            const leaderboard = results.players.map((player, index) => {
                // Calculate the offset when we have a playerUID
                let medal = '';
                let position = index + 1 + offset; // We are 1-based, even with the offset
                if (position === 1) medal = `#${position} 🥇`;
                else if (position === 2) medal = `#${position} 🥈`;
                else if (position === 3) medal = `#${position} 🥉`;
                else medal = `#${position} `;

                let unitSuffix = '';
                if (distance_stats.includes(stat)) {
                    // If the stat is a distance stat, we need to convert it to km
                    if (player[stat] > 1000) {
                        player[stat] = player[stat] / 1000;
                        unitSuffix = ' km';
                    } else {
                        unitSuffix = ' m';
                    }
                }
                if (stat === 'minutes_played_in_league') {
                    player[stat] = player[stat] / 60;
                    unitSuffix = ' hours';
                }
                const value = typeof player[stat] === 'number'
                    ? (Number.isInteger(player[stat])
                        ? player[stat].toString()
                        : Number(player[stat]).toFixed(1))
                    : player[stat];
                  
                let displayPlayerName = escapeMarkdown(player.playerName);
                // Now we should highlight the requested player
                if (requestedPlayerInResults && player.playerUID === results.requestedPlayer.uid) {
                  medal = '**' + medal;
                  displayPlayerName = `${displayPlayerName}**`;
                }

                return `${medal}${displayPlayerName} — ${value}${unitSuffix}`;
            }).join('\n');


            if (identifier && !requestedPlayerInResults) {
              interaction.editReply(`Requested player was not found in the rankings for '${statName}'.`);
              return;
            }

            const formattedStartDate = new Date(results.league.startDate).toLocaleDateString('en-GB', {
                weekday: 'short',
                day: '2-digit',
                month: 'short',
                year: 'numeric'
            });

            let titleEmoji = playerUID ? '⭐' : '🏆';
            // if your rank is in the bottom 20%, change it to a crying face emoji
            if (results.requestedPlayer && results.requestedPlayer.position > Math.floor(totalPlayerCount * 0.8)) {
                titleEmoji = '😭';
            } else if (results.requestedPlayer && results.requestedPlayer.position > Math.floor(totalPlayerCount * 0.2)) {
                titleEmoji = '😎';
            };

            const title = playerUID ? `${escapeMarkdown(requestedPlayerName)}'s personal ranking for ${statName}` : `Top ${resultCount} ${statName}`;
            let header;
            if (playerUID) {
                header = `**${escapeMarkdown(requestedPlayerName)}** is ranked ${results.requestedPlayer.position} of ${totalPlayerCount} active players.`;
            } else {
                header = `Here are the top ${resultCount} players for ${statName} out of ${totalPlayerCount} players.`;
            }

            const embed = new EmbedBuilder()
                .setTitle(`${titleEmoji} ${title} ${titleEmoji}`)
                .setDescription(
                  `${header}\n\n${leaderboard}`
                )
                .setFooter({ text: `League No.${results.league.number} started on ${formattedStartDate} with ${results.league.totalEntrantCount} entrants.` })
                .setColor(0x0099FF);

            await interaction.editReply({ embeds: [embed] });
        } else if (subcommand === 'wipe') {
            // call wipeLeagueStats
            await pluginInstance.wipeAllLeagueStats();
            await interaction.editReply('League stats wiped.');        
        } else if (subcommand === 'debuginfo') {
            // check for an identifier
            const identifier = interaction.options.getString('identifier', false);
            // get the shape / type of the identifier
            let playerUID = null;
            if (identifier) {
                const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
                if (!isUUID) {
                    const playerUIDResult = await pluginInstance.getPlayerUIDByName(identifier);
                    if (!playerUIDResult) {
                        await interaction.editReply(`Cannot find single match with name: ${identifier}`);
                        return;
                    }
                    playerUID = playerUIDResult;
                } else {
                    playerUID = identifier;
                }
            }
            
            const leagueInfo = await pluginInstance.getCurrentLeagueInfo(playerUID);
            if (!leagueInfo) {
                await interaction.editReply('Could not get info for current league.');
                return;
            }

            // dump the league info to the console
            logger.verbose(`[League Command] League Info: ${JSON.stringify(leagueInfo, null, 2)}`);

            const formattedStartDate = new Date(leagueInfo.startDate).toLocaleDateString('en-GB', {
                weekday: 'short',
                day: '2-digit',
                month: 'short',
                year: 'numeric'
            });

            let description = `**Start Date:** ${formattedStartDate}\n`;
            if (leagueInfo.playerStats.length === 1) {
                description += `\n**Player UID:** ${leagueInfo.playerStats[0].playerUID}`;
                description += `\n**Player Name:** ${leagueInfo.playerStats[0].playerName}`;
                // Now print out the stats, and use 3 numbers per line, showing current - base = diff
                description += `\n**Stats:**\n`;
                

                // "playerStats": [
                //   {
                //     "playerName": "pihvi",
                //     "playerUID": "2336d82b-6288-4b94-95bd-c71b6ebee597",
                //     "baseStats": {
                //       "kills": 1284,
                //       "ai_kills": 573,
                //       "deaths": 466,
                //       "distance_walked": 249345,
                //       "distance_driven": 8780240,
                //       "bandage_friendlies": 11,
                //       "tourniquet_friendlies": 0,
                //       "saline_friendlies": 0,
                //       "morphine_friendlies": 6
                //     },
                //     "currentStats": {
                //       "kills": 1285,
                //       "ai_kills": 574,
                //       "deaths": 472,
                //       "distance_walked": 253923,
                //       "distance_driven": 8835660,
                //       "bandage_friendlies": 11,
                //       "tourniquet_friendlies": 0,
                //       "saline_friendlies": 1,
                //       "morphine_friendlies": 8
                //     },
                //     "diffStats": {
                //       "kills": 1,
                //       "ai_kills": 1,
                //       "deaths": 6,
                //       "distance_walked": 4578,
                //       "distance_driven": 55420,
                //       "bandage_friendlies": 0,
                //       "tourniquet_friendlies": 0,
                //       "saline_friendlies": 1,
                //       "morphine_friendlies": 2
                //     }
                //   }
                // ]

                // Playerstats is stored in the above format. I want to go through each line and display the stats in a readable format.
                // So we have ${stat.current} - ${stat.base} = ${stat.diff}
                const statKeys = Object.keys(leagueInfo.playerStats[0].baseStats);
                description += statKeys
                    .map(stat => {
                        const current = leagueInfo.playerStats[0].currentStats[stat] || 0;
                        const base = leagueInfo.playerStats[0].baseStats[stat] || 0;
                        const diff = leagueInfo.playerStats[0].diffStats[stat] || 0;
                        return `**${stat}**: ${current} - ${base} = ${diff}`;
                    })
                    .join('\n');

            } else {
                description += `\n\n**Total entrants currently playing:** ${leagueInfo.playerStats.length}`;
            }

            const embed = new EmbedBuilder()
                .setTitle(`🏆 League No.${leagueInfo.leagueNumber} Info 🏆`)
                .setDescription(description)
                .setColor(0x0099FF)
                .setFooter({ text: `EXD ReforgerJS customised by Bewilderbeest` });

            await interaction.editReply({ embeds: [embed] });
        }
        else {
            await interaction.editReply(`Unknown subcommand: ${subcommand}`);
            return;
        }
    }
    catch (error) {
        logger.error('Error in league command:', error);
        return;
    }
}


