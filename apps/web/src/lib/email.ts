import "server-only";
import { Resend } from "resend";

/**
 * Email utility for workspace invite emails via Resend.
 * Gracefully degrades if RESEND_API_KEY is not configured.
 */

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

/**
 * Send a workspace invite email.
 * Returns { sent: true } on success, { sent: false } if Resend is not configured or fails.
 */
export async function sendInviteEmail(
  to: string,
  inviteLink: string,
  workspaceName: string,
  inviterName: string,
): Promise<{ sent: boolean }> {
  if (!resend) {
    console.warn(
      "[email] RESEND_API_KEY not configured — invite email not sent. Share the invite link manually.",
    );
    return { sent: false };
  }

  try {
    await resend.emails.send({
      from: "StoryCapture <noreply@storycapture.app>",
      to,
      subject: `[${workspaceName}] You've been invited to collaborate`,
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #09090b; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 560px; margin: 40px auto; background-color: #18181b; border-radius: 12px; border: 1px solid #27272a;">
    <tr>
      <td style="padding: 40px 32px;">
        <h1 style="margin: 0 0 8px; font-size: 20px; font-weight: 600; color: #fafafa;">
          You're invited to collaborate
        </h1>
        <p style="margin: 0 0 24px; font-size: 14px; color: #a1a1aa; line-height: 1.6;">
          <strong style="color: #e4e4e7;">${inviterName}</strong> has invited you to join
          <strong style="color: #e4e4e7;">${workspaceName}</strong> on StoryCapture.
        </p>
        <a href="${inviteLink}"
           style="display: inline-block; padding: 10px 24px; background-color: #fafafa; color: #09090b; font-size: 14px; font-weight: 500; text-decoration: none; border-radius: 8px;">
          Accept Invite
        </a>
        <p style="margin: 24px 0 0; font-size: 12px; color: #71717a; line-height: 1.5;">
          This invite expires in 7 days. If you didn't expect this email, you can safely ignore it.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
      `.trim(),
    });

    return { sent: true };
  } catch (error) {
    console.error("[email] Failed to send invite email:", error);
    return { sent: false };
  }
}
