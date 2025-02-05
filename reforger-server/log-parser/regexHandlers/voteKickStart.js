const { EventEmitter } = require('events');

class VoteKickStartHandler extends EventEmitter {
    constructor() {
        super();
        this.regex = /(\d{2}:\d{2}:\d{2}\.\d{3}).*?Player '(\d+)' approved vote \| Vote Type: 'KICK'.*?\| Count \(1\/\d+\)/;
    }

    processLine(line) {
        const match = this.regex.exec(line);
        if (match) {
            const time = match[1];
            const playerId = match[2];
            this.emit('voteKickStart', { time, playerId });
        }
    }
}

module.exports = VoteKickStartHandler;
