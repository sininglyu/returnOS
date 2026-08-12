// Nodemailer wrapper. All outbound email goes through this file so it can
// be mocked in tests — nothing outside lib/ should import nodemailer
// directly.
//
// SECURITY: nodemailer has an open advisory (GHSA-p6gq-j5cr-w38f, no fix
// available) where the message-level `raw` option can bypass
// disableFileAccess/disableUrlAccess (SSRF / arbitrary file read). Never
// pass the `raw` option here, and never build a message from unsanitized
// external input — messages are always constructed from our own structured
// Purchase/Reminder data, never from raw email content.

// TODO(item 7): send the 7-day / 2-day deadline reminder email via
// Resend or SMTP (see .env.example for the transport config names).

export async function sendReminderEmail(_input: {
  to: string;
  itemName: string;
  retailer: string;
  daysRemaining: number;
}): Promise<void> {
  throw new Error("not implemented");
}
