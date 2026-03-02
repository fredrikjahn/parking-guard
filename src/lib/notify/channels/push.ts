export async function sendPushPlaceholder(input: {
  toUserId: string;
  title: string;
  body: string;
}): Promise<void> {
  console.log('[push-placeholder]', {
    toUserId: input.toUserId,
    title: input.title,
    body: input.body,
  });
}
