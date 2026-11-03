import 'canvas-fixture';
import { api } from 'chat-api';

Object.assign(api, {
  uploadAttachment: async (_mode, _taskId, file, progress) => {
    progress(100);
    return { id: `uploaded-${file.name}`, filename: file.name, size: file.size, mediaType: file.type, status: 'available' };
  },
  removeAttachment: async () => {},
});
