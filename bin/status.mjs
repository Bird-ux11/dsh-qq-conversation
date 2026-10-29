import { resolve } from 'node:path';
import { StateFile } from '../lib/state.mjs';
import { ConversationScheduler } from '../lib/scheduler.mjs';

if (!process.argv[2]) {
  process.stderr.write('Usage: node bin/status.mjs <absolute-path-to-state.json>\n');
  process.exitCode = 2;
} else {
  const state = new StateFile(resolve(process.argv[2])).read();
  if (!state) throw new Error('State file does not exist');
  const scheduler = new ConversationScheduler({}, { state: state.scheduler });
  process.stdout.write(`${JSON.stringify({ groups: scheduler.status(), unresolved: Object.values(scheduler.state.tasks)
    .filter(task => task.requiresReview || task.status === 'uncertain')
    .map(task => ({ taskId: task.id, groupId: task.groupId, status: task.status,
      messageIds: task.reviewMessageIds, errors: task.errors })) }, null, 2)}\n`);
}
