const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const VoteKickStartHandler = require('./regexHandlers/voteKickStart');
const VoteKickVictimHandler = require('./regexHandlers/voteKickVictim');
const PlayerJoinedHandler = require('./regexHandlers/playerJoined');
const PlayerUpdateHandler = require('./regexHandlers/playerUpdate');

class LogParser extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.currentLogPath = null;
        this.lastFileSize = 0;
        this.scanInterval = 3000; 
        this.stateSaveInterval = 60000; 
        this.intervalID = null;
        this.stateSaveID = null;
        this.stateFile = path.resolve(__dirname, 'logparser_state.json'); 

        // Placeholders for regex handlers
        this.voteKickStartHandler = null;
        this.voteKickVictimHandler = null;
        this.playerJoinedHandler = null;
        this.playerUpdateHandler = null;
    }

    setupRegexHandlers() {
        logger.verbose('Setting up regex handlers.');

        try {
            this.voteKickStartHandler = new VoteKickStartHandler();
            this.voteKickVictimHandler = new VoteKickVictimHandler();
            this.playerJoinedHandler = new PlayerJoinedHandler();
            this.playerUpdateHandler = new PlayerUpdateHandler();

            logger.verbose('Regex handlers initialized successfully.');

            this.voteKickStartHandler.on('voteKickStart', data => {
                this.emit('voteKickStart', data);
            });

            this.voteKickVictimHandler.on('voteKickVictim', data => {
                this.emit('voteKickVictim', data);
            });

            this.playerJoinedHandler.on('playerJoined', data => {
                this.emit('playerJoined', data);
            });

            this.playerUpdateHandler.on('playerUpdate', data => {
                this.emit('playerUpdate', data);
            });
        } catch (error) {
            logger.error(`Error setting up regex handlers: ${error.message}`);
        }
    }

    start() {
        logger.info('LogParser starting.');

        try {
            this.loadState(); // Load previous state if available
            this.setupRegexHandlers();
            this.findLatestLogFile();

            if (!this.currentLogPath) {
                logger.error('No log file found to monitor.');
                return;
            }

            logger.info(`Monitoring log file: ${this.currentLogPath}`);

            this.intervalID = setInterval(() => this.scanLogs(), this.scanInterval);
            this.stateSaveID = setInterval(() => this.saveState(), this.stateSaveInterval);
        } catch (error) {
            logger.error(`Error during LogParser startup: ${error.message}`);
        }
    }

    stop() {
        logger.info('LogParser stopping.');

        if (this.intervalID) {
            clearInterval(this.intervalID);
            this.intervalID = null;
        }

        if (this.stateSaveID) {
            clearInterval(this.stateSaveID);
            this.stateSaveID = null;
        }

        this.saveState(); // Save state on stop
    }

    findLatestLogFile() {
        const logsDir = this.config.server.logDir;

        try {
            const dirs = fs.readdirSync(logsDir, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory() && dirent.name.startsWith('logs_'))
                .map(dirent => dirent.name)
                .sort();

            if (!dirs.length) {
                logger.warn('No log subdirectories found.');
                return;
            }

            const latestDir = dirs[dirs.length - 1];
            const potentialPath = path.join(logsDir, latestDir, 'console.log');

            if (fs.existsSync(potentialPath)) {
                if (this.currentLogPath !== potentialPath) {
                    this.currentLogPath = potentialPath;
                    this.lastFileSize = 0; // Reset file size if the file changes
                    logger.info(`LogParser now monitoring: ${this.currentLogPath}`);
                }
            } else {
                logger.warn(`console.log not found in directory: ${latestDir}`);
            }
        } catch (err) {
            logger.error(`Error finding latest log file: ${err.message}`);
        }
    }

    scanLogs() {
        this.findLatestLogFile();

        if (!this.currentLogPath) {
            logger.warn('No log file to scan.');
            return;
        }

        try {
            const stats = fs.statSync(this.currentLogPath);
            const newSize = stats.size;

            if (newSize > this.lastFileSize) {
                const stream = fs.createReadStream(this.currentLogPath, {
                    start: this.lastFileSize,
                    end: newSize - 1, // Adjust end to avoid errors
                });

                let data = '';

                stream.on('data', chunk => {
                    data += chunk.toString();
                });

                stream.on('end', () => {
                    const lines = data.split(/\r?\n/);
                    logger.verbose(`Processing ${lines.length} new lines.`);

                    for (const line of lines) {
                        if (line) {
                            this.processLine(line);
                        }
                    }

                    this.lastFileSize = newSize;
                    stream.destroy();
                });

                stream.on('error', err => {
                    logger.error(`Error reading log file: ${err.message}`);
                    stream.destroy();
                });
            }
        } catch (err) {
            logger.error(`Error scanning logs: ${err.message}`);
        }
    }

    processLine(line) {
        if (this.voteKickStartHandler) {
            this.voteKickStartHandler.processLine(line);
        }

        if (this.voteKickVictimHandler) {
            this.voteKickVictimHandler.processLine(line);
        }

        if (this.playerJoinedHandler) {
            this.playerJoinedHandler.processLine(line);
        }

        if (this.playerUpdateHandler) {
            this.playerUpdateHandler.processLine(line);
        }
    }

    saveState() {
        try {
            const state = {
                currentLogPath: this.currentLogPath,
                lastFileSize: this.lastFileSize,
            };
            fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2), 'utf-8');
            logger.verbose('Log parser state saved.');
        } catch (error) {
            logger.error(`Failed to save state: ${error.message}`);
        }
    }

    loadState() {
        try {
            if (fs.existsSync(this.stateFile)) {
                const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
                this.currentLogPath = state.currentLogPath || null;
                this.lastFileSize = state.lastFileSize || 0;
                logger.verbose('Log parser state loaded.');
            } else {
                logger.warn('No previous state found.');
            }
        } catch (error) {
            logger.error(`Failed to load state: ${error.message}`);
        }
    }
}

module.exports = LogParser;
