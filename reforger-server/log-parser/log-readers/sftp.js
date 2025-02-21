const path = require('path');
const SftpClient = require('ssh2-sftp-client');
const fs = require('fs');

class SFTPLogReader {
  constructor(queueLine, options = {}) {
    ['sftp', 'logDir', 'filename'].forEach(option => {
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
    this.initialized = false;
  }

  async findLatestRemoteLogFile() {
    const sftp = new SftpClient();
    try {
      await sftp.connect(this.options.sftp);
      const list = await sftp.list(this.options.logDir);
      const dirs = list
        .filter(item => item.type === 'd' && item.name.startsWith("logs_"))
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
        await sftp.stat(remoteFilePath);
      } catch (err) {
        throw new Error(`No log file found to monitor at ${remoteFilePath}`);
      }
      return remoteFilePath;
    } finally {
      await sftp.end();
    }
  }

  async getRemoteFileSize(filePath) {
    const sftp = new SftpClient();
    try {
      await sftp.connect(this.options.sftp);
      const stats = await sftp.stat(filePath);
      return stats.size;
    } finally {
      await sftp.end();
    }
  }

  async backfillFile(filePath) {
    const sftp = new SftpClient();
    try {
      await sftp.connect(this.options.sftp);
      const data = await sftp.get(filePath);
      const fileContent = data.toString("utf8");
      const lines = fileContent.split(/\r?\n/);
      for (const line of lines) {
        if (line.trim() !== '') {
          this.queueLine(line);
        }
      }
      global.logger.info(`Backfilled ${lines.length} lines from ${filePath}`);
    } finally {
      await sftp.end();
    }
  }

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
    const { SFTPTail } = await import('ftp-tail');
    this.currentFilePath = await this.findLatestRemoteLogFile();

    const errorHandler = async (err) => {
      if (
        err.message &&
        (err.message.includes("InvalidRange") ||
         err.message.includes("I/O error") ||
         err.message.includes("EPERM"))
      ) {
        global.logger.warn(`SFTPTail encountered an error: ${err.message}. Waiting 10 seconds before reinitializing...`);
        try {
          await this.reader.unwatch();
        } catch (unwatchErr) {
          global.logger.error("Error during unwatch: " + unwatchErr.message);
        }
        this.reader = null;
        let offset = 0;
        try {
          offset = await this.getRemoteFileSize(this.currentFilePath);
        } catch (sizeErr) {
          global.logger.error("Error retrieving remote file size: " + sizeErr.message);
        }
        setTimeout(async () => {
          try {
            const { SFTPTail } = await import('ftp-tail');
            this.reader = new SFTPTail({
              sftp: this.options.sftp,
              fetchInterval: this.options.fetchInterval || 0,
              maxTempFileSize: this.options.maxTempFileSize || 5 * 1000 * 1000,
              offset: offset,
            });
            this.reader.on('line', this.queueLine);
            this.reader.on('error', errorHandler);
            await this.reader.watch(this.currentFilePath, { offset: offset });
            global.logger.info("Reinitialized SFTPTail successfully.");
          } catch (watchErr) {
            global.logger.error("Error re-watching the file: " + watchErr.message);
          }
        }, 10000);
      } else {
        global.logger.error("SFTPTail encountered an error: " + err.message);
      }
    };

    this.reader = new SFTPTail({
      sftp: this.options.sftp,
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

module.exports = SFTPLogReader;
