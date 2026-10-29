// Local-only entrypoint. No LINE webhook or LINE sender is attached to this preview.
import { AssistantInbox, assistantRequest } from './assistant.js';
export { AssistantInbox };
export default {fetch:assistantRequest};
