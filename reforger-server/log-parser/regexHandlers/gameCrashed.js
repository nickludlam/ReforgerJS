const { EventEmitter } = require('events');

class GameCrashedHandler extends EventEmitter {
    constructor() {
        super();
        // 2025-05-21 22:36:07.555 ENGINE    (E): Application crashed! Generated memory dump: /tmp/f65fce06-863c-4d87-bac6f889-05f11c85.dmp
        this.regex = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\sENGINE\s+\(E\): Application crashed! Generated memory dump:/;
    }

    test(line) {
        return this.regex.test(line);
    }

    processLine(line) {
        const match = this.regex.exec(line);
        if (match) {
            const time = match[1];
            this.emit('gameCrashed', { time });
        }
    }
}

module.exports = GameCrashedHandler;