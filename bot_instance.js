const bots = {
  admin: null,
  notice: null,
};

function setBot(name, instance) {
  if (bots.hasOwnProperty(name)) {
    bots[name] = instance;
  }
}

function getBot(name) {
  return bots[name] || null;
}

module.exports = {
  setBot,
  getBot,
};
