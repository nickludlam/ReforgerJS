const { parseLogDate } = require('../../../helpers');
const { EventEmitter } = require('events');

class ServerStartHandler extends EventEmitter {
    constructor() {
        super();
        // Matches lines like:
        // 2025-05-26 18:55:21.754 ENGINE       : CLI Params: -config /path/to/server.json
        this.regex = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+ENGINE\s+:\s+CLI Params:.*-config\s+([^\s]+).*/;
    }

    test(line) {
        return this.regex.test(line);
    }

    processLine(line) {
        const match = this.regex.exec(line);
        if (match) {
            const time = parseLogDate(match[1]);
            const configPath = match[2];
            // extract the filename from the path
            const configFileName = configPath.split('/').pop();
            this.emit('serverStart', { time, configFileName });
        }
    }
}

module.exports = ServerStartHandler;

