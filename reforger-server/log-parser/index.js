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

      this.voteKickStartHandler = new VoteKickStartHandler();
      this.voteKickVictimHandler = new VoteKickVictimHandler();
      this.playerJoinedHandler = new PlayerJoinedHandler();
      this.playerUpdateHandler = new PlayerUpdateHandler();
      this.serverHealthHandler = new ServerHealthHandler();

      // Re-emit events from regex handlers.
      this.voteKickStartHandler.on('voteKickStart', data => this.emit('voteKickStart', data));
      this.voteKickVictimHandler.on('voteKickVictim', data => this.emit('voteKickVictim', data));
      this.playerJoinedHandler.on('playerJoined', data => this.emit('playerJoined', data));
      this.playerUpdateHandler.on('playerUpdate', data => this.emit('playerUpdate', data));
      this.serverHealthHandler.on('serverHealth', data => this.emit('serverHealth', data));
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

    this.linesPerMinute++;
  }

  watch() {
    logger.verbose('LogParser - Starting log reader...');
    this.logReader.watch();
    this.parsingStatsInterval = setInterval(() => this.logStats(), 60 * 1000);
  }

  logStats() {
    const avgLatency = this.matchingLinesPerMinute > 0 ? this.matchingLatency / this.matchingLinesPerMinute : 0;
    logger.info(`LogParser - Lines/min: ${this.linesPerMinute} | Matching lines: ${this.matchingLinesPerMinute} | Avg latency: ${avgLatency}ms`);
    this.linesPerMinute = 0;
    this.matchingLinesPerMinute = 0;
    this.matchingLatency = 0;
  }

  async unwatch() {
    await this.logReader.unwatch();
    if (this.parsingStatsInterval) {
      clearInterval(this.parsingStatsInterval);
    }
  }
}

module.exports = LogParser;
