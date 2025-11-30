const { monitorSeminars } = require('./monitor_seminars');

async function run(context) {
    //                      periodName, startHour, endHour
    return monitorSeminars(context, '점심', 11, 14);
}

module.exports = { run };
