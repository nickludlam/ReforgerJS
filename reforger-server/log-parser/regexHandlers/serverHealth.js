// log-parser/regexHandlers/serverHealth.js
const { EventEmitter } = require('events');

class ServerHealthHandler extends EventEmitter {
    constructor() {
        super();
        this.regex = /^(\d{2}:\d{2}:\d{2}\.\d{3})\s+\S+\s+:\s+FPS:\s+([\d\.]+),.*?Mem:\s+(\d+)\s+kB,.*?Player:\s+(\d+),/;
    }

    test(line) {
        return this.regex.test(line);
      }
    processLine(line) {
        const match = this.regex.exec(line);
        if (match) {
            const fps = parseFloat(match[2]);
            const memory = parseInt(match[3], 10);
            const player = parseInt(match[4], 10);

            this.emit('serverHealth', { fps, memory, player });
        }
    }
}

module.exports = ServerHealthHandler;
