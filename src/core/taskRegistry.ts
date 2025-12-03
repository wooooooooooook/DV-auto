import type { Task } from '../types';

// Simple task registry
const tasks: Task[] = [];

function registerTask(task: Task): void {
  if (!task || !task.name) throw new Error('task must have a name');
  tasks.push(task);
}

function getAll(): Task[] {
  return tasks.slice();
}

function getByType(type: string): Task[] {
  return tasks.filter((t) => t.type === type);
}

function getByName(name: string): Task | undefined {
  return tasks.find((t) => t.name === name);
}

export { registerTask, getAll, getByType, getByName };
