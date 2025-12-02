const { monitorSeminars } = require('./monitor_seminars');

async function run({ page, context }) {
  //                      periodName, startHour, endHour
  return monitorSeminars({ page, context }, '저녁', 17, 21);
}

module.exports = { run };
