
let bot = null;

function setBot(instance) {
    bot = instance;
}

function getBot() {
    return bot;
}

module.exports = {
    setBot,
    getBot,
};
