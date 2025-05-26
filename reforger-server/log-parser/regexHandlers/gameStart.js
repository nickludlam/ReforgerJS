const { parseLogDate } = require('../../../helpers');
const { EventEmitter } = require('events');

class GameStartHandler extends EventEmitter {
    constructor() {
        super();
        this.regex = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+SCRIPT\s+:\s+SCR_BaseGameMode::OnGameStateChanged\s+=\s+GAME/;
    }

    test(line) {
        return this.regex.test(line);
    }

    processLine(line) {
        const match = this.regex.exec(line);
        if (match) {
            const time = parseLogDate(match[1]);
            this.emit('gameStart', { time });
        }
    }
}

module.exports = GameStartHandler;