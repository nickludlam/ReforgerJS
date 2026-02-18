const { NodeSSH } = require('node-ssh');

class SSHLogReader {
  constructor(queueLine, options = {}) {
    // Validate required arguments
    if (typeof queueLine !== 'function') {
      throw new Error('queueLine argument must be specified and be a function.');
    }
    if (!options.logDir) throw new Error('logDir must be specified.');
    if (!options.ssh.host) throw new Error('ssh.host must be specified.');
    if (!options.ssh.username) throw new Error('ssh.username must be specified.');
    if (!options.ssh.privateKey && !options.ssh.privateKeyPath) throw new Error('ssh.privateKey or ssh.privateKeyPath must be specified.');

    this.queueLine = queueLine;
    this.options = options;

    // Timers
    this.detectionInterval = options.detectionInterval || 30000; // The interval to check for new log directories
    this.immediateRetryInterval = 1000; // The interval to retry connecting immediately after the command exits
    this.retryInterval = 10000; // The longer interval between retries after the initial immediate retry

    this.gameLogDirPrefix = "logs_";

    // Internal state management
    this.ssh = options.sshClient || new NodeSSH();
    this.buffer = '';
    this.reconnectTimer = null;
    this.detectionTimer = null;
    this.isWatching = false;
    this.currentLogDir = null;
  }

  async watch() {
    this.isWatching = true;
    this.startDetectionTimer();
    await this.connectAndTail();
  }

  startDetectionTimer() {
    if (this.detectionTimer) clearTimeout(this.detectionTimer);
    this.detectionTimer = setTimeout(() => this.pollForChanges(), this.detectionInterval);
  }

  async pollForChanges() {
    if (!this.isWatching) return;

    try {
      // Only poll if we have something that looks like an active connection
      if (this.ssh && this.ssh.connection) {
        const latest = await this.findLatestLogDir();
        if (latest && latest !== this.currentLogDir) {
          console.log(`SSHLogReader: Detected new log directory: ${latest}. Swapping from ${this.currentLogDir}...`);
          this.currentLogDir = latest;
          // Disposing will trigger the reconnect logic in the active tail's promise
          await this.ssh.dispose();
        }
      }
    } catch (err) {
      // Polling failed, likely connection issue or transitioning. connectAndTail handles reconnection.
    } finally {
      if (this.isWatching) {
        this.startDetectionTimer();
      }
    }
  }

  async findLatestLogDir() {
    // Ensure it only contains allowed characters (alphanumeric, underscores, dashes, slashes, dots) and does not contain any command injection characters.
    const sanitizedLogDir = this.options.logDir.replace(/[^a-zA-Z0-9_\/.-]/g, '').replace(/\/+$/, '');
    const joinedPath = `${sanitizedLogDir}/${this.gameLogDirPrefix}*/`;
    const result = await this.ssh.execCommand(`ls -t1d ${joinedPath} 2>/dev/null | head -n 1`);
    return result.stdout.trim().replace(/\/+$/, '');
  }

  async connectAndTail() {
    if (!this.isWatching) return;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    console.log(`SSHLogReader: Attempting to connect to ${this.options.host}...`);
    try {
      await this.ssh.connect(this.options.ssh);
      console.log('SSHLogReader: Connected to server via SSH.');
      
      this.currentLogDir = await this.findLatestLogDir();
      if (!this.currentLogDir) {
        throw new Error(`No log directory found in ${this.options.logDir} starting with ${this.gameLogDirPrefix}`);
      }

      const logFile = `${this.currentLogDir}/${this.options.filename || 'console.log'}`;
      console.log(`SSHLogReader: Tailing file: ${logFile}`);
      
      const tailCmd = `tail -F ${logFile}`;
      
      this.buffer = ''; // Reset buffer for new file
      this.ssh.execCommand(tailCmd, {
        cwd: '/',
        onStdout: (chunk) => {
            if (!this.isWatching) return;
            this.buffer += chunk.toString('utf8');
            let newlineIndex;
            while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
                const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, '');
                this.buffer = this.buffer.slice(newlineIndex + 1);
                if (line.length > 0) {
                    this.queueLine(line);
                }
            }
        },
        onStderr: (chunk) => {
            console.error('SSHLogReader STDERR:', chunk.toString('utf8'));
        }
      }).then((result) => {
        console.log('SSHLogReader: Command finished (code: ' + result.code + ', signal: ' + result.signal + ')');
        if (this.isWatching) {
             console.log(`SSHLogReader: Reconnecting in ${this.immediateRetryInterval/1000}s...`);
             this.reconnectTimer = setTimeout(() => this.connectAndTail(), this.immediateRetryInterval);
        }
      }).catch((err) => {
         console.error('SSHLogReader: Command execution error:', err.message);
         if (this.isWatching) {
            console.log(`SSHLogReader: Reconnecting in ${this.retryInterval/1000}s...`);
            this.reconnectTimer = setTimeout(() => this.connectAndTail(), this.retryInterval);
         }
      });

    } catch (err) {
      console.error('SSHLogReader Connection Error:', err.message);
      if (this.isWatching) {
          console.log(`SSHLogReader: Retrying in ${this.retryInterval/1000}s...`);
          this.reconnectTimer = setTimeout(() => this.connectAndTail(), this.retryInterval);
      }
    }
  }

  async unwatch() {
    this.isWatching = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.detectionTimer) {
      clearTimeout(this.detectionTimer);
      this.detectionTimer = null;
    }
    if (this.ssh) {
        this.ssh.dispose();
    }
    console.log('SSHLogReader: Unwatched and disposed connection.');
  }
}

module.exports = SSHLogReader;
