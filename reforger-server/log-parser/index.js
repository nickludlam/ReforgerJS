const EventEmitter = require('events');
const async = require('async');
const moment = require('moment');
const TailLogReader = require('./log-readers/tail');
const SFTPLogReader = require('./log-readers/sftp');
const FTPLogReader = require('./log-readers/ftp');

// Use the global logger if available, else fallback to console.
const logger = global.logger || console;

class LogParser extends EventEmitter {
  constructor(filename = 'console.log', options = {}) {
    super();
    options.filename = filename;
    this.options = options;
    
    this.eventStore = {
      disconnected: {},
      players: {},
      session: {},
      joinRequests: []
    };

    this.linesPerMinute = 0;
    this.matchingLinesPerMinute = 0;
    this.matchingLatency = 0;
    this.parsingStatsInterval = null;

    // Bind processLine
    this.processLine = this.processLine.bind(this);

    // Create an async queue to process each line
    this.queue = async.queue((line, callback) => {
      this.processLine(line);
      callback();
    });

    // Instantiate the appropriate log reader based on mode.
    const mode = options.mode || options.logReaderMode || 'tail';

    switch (mode) {
      case 'tail':
        this.logReader = new TailLogReader(this.queue.push.bind(this.queue), options);
        break;
      case 'sftp':
        this.logReader = new SFTPLogReader(this.queue.push.bind(this.queue), options);
        break;
      case 'ftp':
        this.logReader = new FTPLogReader(this.queue.push.bind(this.queue), options);
        break;
      default:
        throw new Error('Invalid logReader mode.');
    }

    // Set up regex handlers.
    this.setupRegexHandlers();
  }

  setupRegexHandlers() {
    try {
      const VoteKickStartHandler = require('./regexHandlers/voteKickStart');
      const VoteKickVictimHandler = require('./regexHandlers/voteKickVictim');
      const PlayerJoinedHandler = require('./regexHandlers/playerJoined');
      const PlayerUpdateHandler = require('./regexHandlers/playerUpdate');
      const ServerHealthHandler = require('./regexHandlers/serverHealth');
      const GameStartHandler = require('./regexHandlers/gameStart');
      const GameEndHandler = require('./regexHandlers/gameEnd');

      this.voteKickStartHandler = new VoteKickStartHandler();
      this.voteKickVictimHandler = new VoteKickVictimHandler();
      this.playerJoinedHandler = new PlayerJoinedHandler();
      this.playerUpdateHandler = new PlayerUpdateHandler();
      this.serverHealthHandler = new ServerHealthHandler();
      this.gameStartHandler = new GameStartHandler();
      this.gameEndHandler = new GameEndHandler();


      this.removeAllListeners();

      // Re-emit events from regex handlers.
      this.voteKickStartHandler.on('voteKickStart', data => this.emit('voteKickStart', data));
      this.voteKickVictimHandler.on('voteKickVictim', data => this.emit('voteKickVictim', data));
      this.playerJoinedHandler.on('playerJoined', data => this.emit('playerJoined', data));
      this.playerUpdateHandler.on('playerUpdate', data => this.emit('playerUpdate', data));
      this.serverHealthHandler.on('serverHealth', data => this.emit('serverHealth', data));
      this.gameStartHandler.on('gameStart', data => this.emit('gameStart', data));
      this.gameEndHandler.on('gameEnd', data => this.emit('gameEnd', data));
    } catch (error) {
      logger.error(`Error setting up regex handlers: ${error.message}`);
    }
  }

  processLine(line) {
   // logger.verbose('LogParser', `Processing line: ${line}`);

    if (this.voteKickStartHandler && this.voteKickStartHandler.test(line)) {
      this.voteKickStartHandler.processLine(line);
      this.matchingLinesPerMinute++;
      return;
    }
    if (this.voteKickVictimHandler && this.voteKickVictimHandler.test(line)) {
      this.voteKickVictimHandler.processLine(line);
      this.matchingLinesPerMinute++;
      return;
    }
    if (this.playerJoinedHandler && this.playerJoinedHandler.test(line)) {
      this.playerJoinedHandler.processLine(line);
      this.matchingLinesPerMinute++;
      return;
    }
    if (this.playerUpdateHandler && this.playerUpdateHandler.test(line)) {
      this.playerUpdateHandler.processLine(line);
      this.matchingLinesPerMinute++;
      return;
    }
    if (this.serverHealthHandler && this.serverHealthHandler.test(line)) {
      this.serverHealthHandler.processLine(line);
      this.matchingLinesPerMinute++;
      return;
    }
    if (this.gameStartHandler && this.gameStartHandler.test(line)) {
      this.gameStartHandler.processLine(line);
      this.matchingLinesPerMinute++;
      return;
    }
    if (this.gameEndHandler && this.gameEndHandler.test(line)) {
      this.gameEndHandler.processLine(line);
      this.matchingLinesPerMinute++;
      return;
    }

    this.linesPerMinute++;
  }

  watch() {
    logger.verbose('LogParser - Starting log reader...');
    
    try {
      this.logReader.watch();
    } catch (error) {
      logger.error(`LogReader watch failed: ${error.message}`);
      return;
    }
  
    if (this.parsingStatsInterval) clearInterval(this.parsingStatsInterval);
  
    this.parsingStatsInterval = setInterval(() => this.logStats(), 60 * 1000);
  }

  logStats() {
    logger.info(`LogParser - Lines/min: ${this.linesPerMinute} | Matching lines: ${this.matchingLinesPerMinute}`);
    this.linesPerMinute = 0;
    this.matchingLinesPerMinute = 0;
    this.matchingLatency = 0;
  }

  async unwatch() {
    try {
      if (this.logReader) await this.logReader.unwatch();
    } catch (error) {
      logger.error(`Error stopping LogReader: ${error.message}`);
    }

    if (this.parsingStatsInterval) {
      clearInterval(this.parsingStatsInterval);
      this.parsingStatsInterval = null;
    }

    this.queue.kill();
    this.removeAllListeners();
  }

}

module.exports = LogParser;
