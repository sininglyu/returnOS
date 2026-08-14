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

import nodemailer, { type Transporter } from "nodemailer";

// Lazily created and memoized so the module doesn't throw at import time
// when SMTP env is unset, but is reused across sends within one
// invocation (lib/reminders.ts sends sequentially in a loop).
let transport: Transporter | undefined;

function getTransport(): Transporter {
  if (transport) return transport;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASSWORD) {
    // Caller (lib/reminders.ts) treats a thrown send as "skip this
    // purchase, don't record a Reminder" - fails safe on a misconfigured
    // prod env instead of silently burning the send-once guard.
    throw new Error("SMTP transport not configured (missing env)");
  }

  const port = Number(SMTP_PORT); // env vars are always strings
  transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
  });
  return transport;
}

export async function sendReminderEmail(input: {
  to: string;
  itemName: string;
  retailer: string;
  daysRemaining: number;
}): Promise<void> {
  const { to, itemName, retailer, daysRemaining } = input;
  const subject = `Return window closing: ${itemName} (${daysRemaining} days left)`;
  const text =
    `Your ${retailer} order "${itemName}" has ${daysRemaining} day(s) left ` +
    `in its return window.`;
  const html =
    `<p>Your ${retailer} order <strong>${itemName}</strong> has ` +
    `<strong>${daysRemaining} day(s)</strong> left in its return window.</p>`;

  await getTransport().sendMail({
    from: process.env.EMAIL_FROM,
    to,
    subject,
    text,
    html,
  });
}
