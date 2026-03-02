export async function sendEmailStub(input: {
  toUserId: string;
  subject: string;
  body: string;
}): Promise<void> {
  console.log('[email-stub]', {
    toUserId: input.toUserId,
    subject: input.subject,
    body: input.body,
  });
}
