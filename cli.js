import fs from 'fs';
import path from 'path';
import { Console } from 'console';
import { Transform } from 'stream';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import logger from './reforger-server/logger/logger.js';
import EXDLeague from './reforger-server/plugins/EXDLeague.js';


// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configPath = path.resolve(__dirname, './config.json');
const rawData = fs.readFileSync(configPath, 'utf8');
const config = JSON.parse(rawData);


function table(input) {
  // @see https://stackoverflow.com/a/67859384
  const ts = new Transform({ transform(chunk, enc, cb) { cb(null, chunk) } })
  const logger = new Console({ stdout: ts })
  logger.table(input)
  const table = (ts.read() || '').toString()
  let result = '';
  for (let row of table.split(/[\r\n]+/)) {
    let r = row.replace(/[^┬]*┬/, '┌');
    r = r.replace(/^├─*┼/, '├');
    r = r.replace(/│[^│]*/, '');
    r = r.replace(/^└─*┴/, '└');
    r = r.replace(/'/g, ' ');
    result += `${r}\n`;
  }
  console.log(result);
}

if (config.connectors.mysql && config.connectors.mysql.enabled) {
  const mysqlConfig = config.connectors.mysql;
  const maxRetries = Infinity;
  const initialRetryDelay = 5000; 
  let retryDelay = initialRetryDelay;

  const createMySQLPool = async () => {
    console.log('Attempting to connect to MySQL...');
    try {
      const pool = mysql.createPool({
        host: mysqlConfig.host,
        port: mysqlConfig.port || 3306,
        user: mysqlConfig.username,
        password: mysqlConfig.password,
        database: mysqlConfig.database,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        connectTimeout: 10000
      });

      await pool.query('SELECT 1');
      logger.info('MySQL connected successfully.');
      retryDelay = initialRetryDelay;
      return pool;
    } catch (error) {
      logger.error(`MySQL connection failed: ${error.message}`);
      throw error;
    }
  };

  const connectWithRetry = async () => {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        const pool = await createMySQLPool();
        return pool;
      } catch (error) {
        attempt += 1;
        logger.warn(`MySQL reconnection attempt ${attempt} failed. Retrying in ${retryDelay / 1000} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        retryDelay = Math.min(retryDelay * 2, 60000);
      }
    }
    throw new Error('Max MySQL reconnection attempts reached.');
  };

  const mysqlPool = await connectWithRetry();
  process.mysqlPool = mysqlPool;

  mysqlPool.on('error', async (err) => {
    logger.error(`MySQL Pool Error: ${err.message}`);
    if (err.code === 'PROTOCOL_CONNECTION_LOST' || err.fatal) {
      logger.warn('MySQL connection lost. Attempting to reconnect...');
      try {
        const newPool = await connectWithRetry();
        process.mysqlPool = newPool;
        logger.info('MySQL reconnected successfully.');
      } catch (error) {
        logger.error(`Failed to reconnect to MySQL: ${error.message}`);
      }
    } else {
      logger.error(`Unhandled MySQL Pool Error: ${err.message}`);
    }
  });
} else {
  logger.warn('MySQL connector is not enabled in the config. Skipping MySQL connection setup.');
}

// Parse command line arguments
const command = process.argv[2] || 'show';
logger.info(`Command received: ${command}`);

// Main program execution starts immediately without waiting for MySQL connection
console.log(`Starting CLI with '${command}' command`);
runMainProgram(config, command);

/**
 * Main program function that contains your CLI logic
 * @param {string} command - The command to execute (start, show, wipe)
 */
async function runMainProgram(config, command) {
  try {
    const leagueInstance = new EXDLeague(config);
    await leagueInstance.prepareToMount();

    // Execute the appropriate command
    switch (command.toLowerCase()) {
      case 'start':
        await handleStartCommand(leagueInstance);
        break;
      
      case 'show':
        await handleShowCommand(leagueInstance);
        break;
        
      case 'wipe':
        await handleWipeCommand(leagueInstance);
        break;
        
      default:
        logger.error(`Unknown command: ${command}`);
        console.log("Available commands: start, show, wipe");
    }
    
    logger.info('Command execution completed');
    
    // Cleanly exit the program when done
    await cleanUp();
  } catch (error) {
    logger.error(`Error in main program: ${error.message}`);
    // Exit with error code on failure
    process.exit(1);
  }
}

/**
 * Handles the 'start' command
 */
async function handleStartCommand(leagueInstance) {
  logger.info('Executing start command...');
  
  if (mysqlAvailable) {
    try {
      const [rows] = await process.mysqlPool.query('SELECT COUNT(*) as count FROM players');
      logger.info(`Player count: ${rows[0].count}`);
    } catch (error) {
      logger.error(`Database error: ${error.message}`);
    }
  } else {
    logger.warn('MySQL connection is not available. Some features may be limited.');
  }
  
  // Add your start command logic here
  console.log("Start command executed successfully");
}

/**
 * Handles the 'show' command
 */
async function handleShowCommand(leagueInstance) {
  logger.info('Executing show command...');
  
  function showLeagueResults(stats, statName, sortKey) {
    console.log(`Top 5 players by ${statName} in week: ${stats.league.number}`);
    
    // Create a dynamic object where the property name comes from sortKey parameter
    table(stats.players.map((player, index) => {
      const playerData = {
        rank: index + 1,
        playerName: player.playerName
      };
      
      // Dynamically set the property name based on sortKey
      playerData[statName] = typeof player[sortKey] === 'number' 
        ? (Number.isInteger(player[sortKey]) ? player[sortKey].toString() : Number(player[sortKey]).toFixed(1))
        : player[sortKey];
      return playerData;
    }));
  }

  // Now lets produce a little ASCI table which displays the playername and the diff_kills of the top 5 players
  const mostKills = await leagueInstance.getLeagueStatsDiff(8, 'diff_kills');
  showLeagueResults(mostKills, 'kills', 'diff_kills');

  const mostAIKills = await leagueInstance.getLeagueStatsDiff(8, 'diff_ai_kills');
  showLeagueResults(mostAIKills, 'AI Kills', 'diff_ai_kills');

  const bestDeaths = await leagueInstance.getLeagueStatsDiff(8, 'diff_deaths');
  showLeagueResults(bestDeaths, 'deaths', 'diff_deaths');

  const bestKD = await leagueInstance.getLeagueStatsDiff(8, 'kd_ratio');
  showLeagueResults(bestKD, 'K/D ratio', 'kd_ratio');

  const bestInfantry = await leagueInstance.getLeagueStatsDiff(8, 'diff_sppointss0');
  showLeagueResults(bestInfantry, 'infantry points', 'diff_sppointss0');  

  const bestVehicle = await leagueInstance.getLeagueStatsDiff(8, 'diff_sppointss1');
  showLeagueResults(bestVehicle, 'logistic points', 'diff_sppointss1');

  const bestSupport = await leagueInstance.getLeagueStatsDiff(8, 'diff_sppointss2');
  showLeagueResults(bestSupport, 'support points', 'diff_sppointss2');

  const bestTeamKiller = await leagueInstance.getLeagueStatsDiff(8, 'diff_friendly_kills');
  showLeagueResults(bestTeamKiller, 'team kills', 'diff_friendly_kills');

  // minutes_played
  const mostMinutesPlayed = await leagueInstance.getLeagueStatsDiff(8, 'minutes_played');
  showLeagueResults(mostMinutesPlayed, 'minutes played', 'minutes_played');
}

/**
 * Handles the 'wipe' command
 */
async function handleWipeCommand(leagueInstance) {
  logger.info('Executing wipe command...');
  await leagueInstance.wipeAllLeagueStats();
}

// Clean up
const cleanUp = async () => {
  if (process.mysqlPool) {
    await process.mysqlPool.end();
    logger.info('MySQL connection closed.');
  }
  process.exit(0);
};
process.on('SIGINT', cleanUp);
process.on('SIGTERM', cleanUp);
process.on('exit', cleanUp);

