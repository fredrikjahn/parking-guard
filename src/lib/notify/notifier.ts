import type { NotificationKind } from '@/lib/db/repo';
import { sendEmailStub } from './channels/email';
import { sendPushPlaceholder } from './channels/push';

export async function notifyParkingEvent(input: {
  userId: string;
  parkingEventId: string;
  kind: NotificationKind;
  summary: string;
}) {
  const subject = input.kind === 'HARD' ? 'Parking Guard: Critical reminder' : 'Parking Guard: Reminder';
  const body = `[${input.kind}] Event ${input.parkingEventId}: ${input.summary}`;

  console.log('[notifier]', {
    userId: input.userId,
    parkingEventId: input.parkingEventId,
    kind: input.kind,
    summary: input.summary,
  });

  await sendEmailStub({
    toUserId: input.userId,
    subject,
    body,
  });

  await sendPushPlaceholder({
    toUserId: input.userId,
    title: subject,
    body,
  });
}
