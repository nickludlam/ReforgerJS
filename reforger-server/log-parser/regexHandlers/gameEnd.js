// log-parser/regexHandlers/gameEnd.js
const { EventEmitter } = require('events');

class GameEndHandler extends EventEmitter {
    constructor() {
        super();
        this.regex = /^(\d{2}:\d{2}:\d{2}\.\d{3})\s+SCRIPT\s+:\s+SCR_BaseGameMode::OnGameStateChanged\s+=\s+POSTGAME/;
    }

    test(line) {
        return this.regex.test(line);
    }

    processLine(line) {
        const match = this.regex.exec(line);
        if (match) {
            const time = match[1];
            this.emit('gameEnd', { time });
        }
    }
}

module.exports = GameEndHandler;