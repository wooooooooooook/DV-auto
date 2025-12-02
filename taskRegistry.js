// Simple task registry
const tasks = [];

function registerTask(task) {
  if (!task || !task.name) throw new Error('task must have a name');
  tasks.push(task);
}

function getAll() {
  return tasks.slice();
}

function getByType(type) {
  return tasks.filter((t) => t.type === type);
}

function getByName(name) {
  return tasks.find((t) => t.name === name);
}

module.exports = { registerTask, getAll, getByType, getByName };
