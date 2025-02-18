const path = require('path');
const ftp = require("basic-ftp");
const { Writable } = require("stream");

class FTPLogReader {
  constructor(queueLine, options = {}) {
    // Ensure required options: ftp credentials, logDir, and filename.
    ['ftp', 'logDir', 'filename'].forEach(option => {
      if (!options[option]) {
        throw new Error(`${option} must be specified.`);
      }
    });
    if (typeof queueLine !== 'function') {
      throw new Error('queueLine argument must be specified and be a function.');
    }
    this.options = options;
    this.queueLine = queueLine;
    this.reader = null;
    this.currentFilePath = null;
    this.newLogCheckInterval = null;
    this.initialized = false; // indicates if backfill has been done already
  }

  // Find the latest remote log file by scanning directories.
  async findLatestRemoteLogFile() {
    const client = new ftp.Client();
    client.ftp.verbose = false;
    try {
      await client.access({
        host: this.options.ftp.host,
        port: this.options.ftp.port,
        user: this.options.ftp.user,
        password: this.options.ftp.password,
        secure: false,
      });
      const list = await client.list(this.options.logDir);
      const dirs = list
        .filter(item => item.isDirectory && item.name.startsWith("logs_"))
        .map(item => item.name);
      dirs.sort();
      let remoteFilePath = "";
      if (dirs.length > 0) {
        const latestDir = dirs[dirs.length - 1];
        remoteFilePath = path.join(this.options.logDir, latestDir, this.options.filename).replace(/\\/g, '/');
      } else {
        remoteFilePath = path.join(this.options.logDir, this.options.filename).replace(/\\/g, '/');
      }
      try {
        await client.size(remoteFilePath);
      } catch (err) {
        throw new Error(`No log file found to monitor at ${remoteFilePath}`);
      }
      return remoteFilePath;
    } finally {
      client.close();
    }
  }

  // Get the current file size from the remote server.
  async getRemoteFileSize(filePath) {
    const client = new ftp.Client();
    client.ftp.verbose = false;
    try {
      await client.access({
        host: this.options.ftp.host,
        port: this.options.ftp.port,
        user: this.options.ftp.user,
        password: this.options.ftp.password,
        secure: false,
      });
      const size = await client.size(filePath);
      return size;
    } finally {
      client.close();
    }
  }

  // Backfill: download entire file and process each line.
  async backfillFile(filePath) {
    const client = new ftp.Client();
    client.ftp.verbose = false;
    class BufferWritable extends Writable {
      constructor(options) {
        super(options);
        this.chunks = [];
      }
      _write(chunk, encoding, callback) {
        this.chunks.push(chunk);
        callback();
      }
      getBuffer() {
        return Buffer.concat(this.chunks);
      }
    }
    const writable = new BufferWritable();
    try {
      await client.access({
        host: this.options.ftp.host,
        port: this.options.ftp.port,
        user: this.options.ftp.user,
        password: this.options.ftp.password,
        secure: false,
      });
      await client.downloadTo(writable, filePath);
      const fileContent = writable.getBuffer().toString("utf8");
      const lines = fileContent.split(/\r?\n/);
      for (const line of lines) {
        if (line.trim() !== '') {
          this.queueLine(line);
        }
      }
      global.logger.info(`Backfilled ${lines.length} lines from ${filePath}`);
    } finally {
      client.close();
    }
  }

  // Periodically check for a new log file.
  async checkForNewLogFile() {
    try {
      const newPath = await this.findLatestRemoteLogFile();
      if (newPath !== this.currentFilePath) {
        global.logger.info(`New log file detected: ${newPath}. Switching...`);
        this.currentFilePath = newPath;
        await this.reader.unwatch();
        if (this.options.backfill) {
          await this.backfillFile(newPath);
        }
        await this.reader.watch(newPath);
      }
    } catch (err) {
      global.logger.error(`Error checking for new log file: ${err.message}`);
    }
  }

  async watch() {
    const { FTPTail } = await import('ftp-tail');
    this.currentFilePath = await this.findLatestRemoteLogFile();

    // Define a dedicated error handler.
    const errorHandler = async (err) => {
      if (err.message && (err.message.includes("InvalidRange") || err.message.includes("I/O error") || err.message.includes("EPERM"))) {
        global.logger.warn(`FTPTail encountered an error: ${err.message}. Waiting 10 seconds before reinitializing...`);
        try {
          await this.reader.unwatch();
        } catch (unwatchErr) {
          global.logger.error("Error during unwatch: " + unwatchErr.message);
        }
        this.reader = null;
        // Before reinitializing, get the current file size and set offset accordingly.
        let offset = 0;
        try {
          offset = await this.getRemoteFileSize(this.currentFilePath);
        } catch (sizeErr) {
          global.logger.error("Error retrieving remote file size: " + sizeErr.message);
        }
        setTimeout(async () => {
          try {
            const { FTPTail } = await import('ftp-tail');
            this.reader = new FTPTail({
              ftp: this.options.ftp,
              fetchInterval: this.options.fetchInterval || 0,
              maxTempFileSize: this.options.maxTempFileSize || 5 * 1000 * 1000,
              // Pass the offset so that we start tailing from the current file size.
              offset: offset,
            });
            this.reader.on('line', this.queueLine);
            this.reader.on('error', errorHandler);
            // Do not backfill on reinitialization (preserve state).
            await this.reader.watch(this.currentFilePath, { offset: offset });
            global.logger.info("Reinitialized FTPTail successfully.");
          } catch (watchErr) {
            global.logger.error("Error re-watching the file: " + watchErr.message);
          }
        }, 10000);
      } else {
        global.logger.error("FTPTail encountered an error: " + err.message);
      }
    };

    // Create new tail instance.
    this.reader = new FTPTail({
      ftp: this.options.ftp,
      fetchInterval: this.options.fetchInterval || 0,
      maxTempFileSize: this.options.maxTempFileSize || 5 * 1000 * 1000,
    });
    this.reader.on('line', this.queueLine);
    this.reader.on('error', errorHandler);

    if (this.options.backfill && !this.initialized) {
      await this.backfillFile(this.currentFilePath);
    }
    this.initialized = true;
    await this.reader.watch(this.currentFilePath);

    // Set up an interval to check for new log file every 60 seconds.
    this.newLogCheckInterval = setInterval(() => this.checkForNewLogFile(), 60000);
  }

  async unwatch() {
    if (this.reader) {
      await this.reader.unwatch();
    }
    if (this.newLogCheckInterval) {
      clearInterval(this.newLogCheckInterval);
      this.newLogCheckInterval = null;
    }
  }
}

module.exports = FTPLogReader;
