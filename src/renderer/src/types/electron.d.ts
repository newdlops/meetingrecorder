import type { MeetingRecorderApi } from '../../../shared/types';

declare global {
  interface Window {
    meetingRecorder: MeetingRecorderApi;
  }
}

export {};
