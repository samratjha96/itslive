const FROM = 'ItsLive <noreply@mail.itslive.fyi>';
const RESEND_API = 'https://api.resend.com/emails';

async function sendEmail(apiKey: string, to: string, subject: string, html: string): Promise<void> {
  const resp = await fetch(RESEND_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Resend ${resp.status}: ${text}`);
  }
}

export async function sendOtp(apiKey: string, email: string, code: string): Promise<void> {
  await sendEmail(apiKey, email, 'Your ItsLive verification code', `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 24px">
      <h1 style="font-size:24px;font-weight:700;margin-bottom:8px">Verify your email</h1>
      <p style="color:#666;margin-bottom:32px">Enter this code to complete your ItsLive sign-up:</p>
      <div style="background:#f4f4f5;border-radius:12px;padding:24px;text-align:center;margin-bottom:32px">
        <span style="font-size:40px;font-weight:700;letter-spacing:8px;font-family:monospace">${code}</span>
      </div>
      <p style="color:#999;font-size:14px">Expires in 10 minutes. One use only.</p>
    </div>`);
}

export async function sendWelcome(apiKey: string, email: string): Promise<void> {
  await sendEmail(apiKey, email, 'Welcome to ItsLive', `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 24px">
      <h1 style="font-size:24px;font-weight:700;margin-bottom:8px">You're live.</h1>
      <p style="color:#666">Your API key has been issued. Deploy your first site in seconds.</p>
    </div>`);
}

export async function sendExistingAccountNotice(apiKey: string, email: string): Promise<void> {
  await sendEmail(apiKey, email, 'ItsLive account activity', `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 24px">
      <h1 style="font-size:24px;font-weight:700;margin-bottom:8px">Sign-up attempt notice</h1>
      <p style="color:#666">Someone tried to create an ItsLive account with your email.</p>
      <p style="color:#666;margin-top:16px">If this was you, check for a separate verification code. If not, no action needed.</p>
    </div>`);
}
