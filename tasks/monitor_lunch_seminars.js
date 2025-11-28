const { monitorSeminars } = require('./monitor_seminars');

async function run({ page, context }) {
    //                      periodName, startHour, endHour
    return monitorSeminars({ page, context }, '점심', 11, 14);
}

module.exports = { run };
