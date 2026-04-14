// Vercel Serverless Function — /api/send-email
// 必要な環境変数（Vercel ダッシュボード > Settings > Environment Variables で設定）:
//   RESEND_API_KEY   : Resend のシークレットキー（例: re_xxxxxxxx）
//   RESEND_FROM_EMAIL: 送信元アドレス（Resend で verified したドメインのアドレス）
//                      例: noreply@uma-biz.co.jp
//                      ※ テスト中は onboarding@resend.dev を使えますが、
//                         宛先は Resend アカウントのメールのみに制限されます
//   NOTIFY_EMAIL     : 通知の受信先アドレス（自分のメールアドレス）
'use strict';

const { Resend } = require('resend');

// HTML インジェクション対策
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = async function handler(req, res) {
  // CORS（Vercel 同一オリジンなので通常不要だが念のため）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { type, company, name, email, plan } = req.body ?? {};

  // サーバーサイドバリデーション
  if (!company || !name || !email) {
    return res.status(400).json({ error: '会社名・お名前・メールアドレスは必須です' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'メールアドレスの形式が正しくありません' });
  }

  const isDemo      = type === 'demo';
  const safeCompany = escapeHtml(company);
  const safeName    = escapeHtml(name);
  const safeEmail   = escapeHtml(email);
  const safePlan    = escapeHtml(plan || '未選択');

  const subject = isDemo
    ? `【無料デモ申し込み】${safeCompany} ${safeName}様`
    : `【お問い合わせ】${safeCompany} ${safeName}様`;

  const planLabel = isDemo ? 'ご関心のプラン' : 'ご用件';

  const html = `
    <!DOCTYPE html>
    <html lang="ja">
    <body style="font-family:sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="color:#1a56db">${isDemo ? '無料デモ申し込み' : 'お問い合わせ'}がありました</h2>
      <table style="width:100%;border-collapse:collapse;margin-top:16px">
        <tr>
          <td style="padding:10px 12px;border:1px solid #ddd;font-weight:bold;width:35%;background:#f9fafb">会社名</td>
          <td style="padding:10px 12px;border:1px solid #ddd">${safeCompany}</td>
        </tr>
        <tr>
          <td style="padding:10px 12px;border:1px solid #ddd;font-weight:bold;background:#f9fafb">お名前</td>
          <td style="padding:10px 12px;border:1px solid #ddd">${safeName}</td>
        </tr>
        <tr>
          <td style="padding:10px 12px;border:1px solid #ddd;font-weight:bold;background:#f9fafb">メールアドレス</td>
          <td style="padding:10px 12px;border:1px solid #ddd"><a href="mailto:${safeEmail}">${safeEmail}</a></td>
        </tr>
        <tr>
          <td style="padding:10px 12px;border:1px solid #ddd;font-weight:bold;background:#f9fafb">${planLabel}</td>
          <td style="padding:10px 12px;border:1px solid #ddd">${safePlan}</td>
        </tr>
      </table>
      <p style="margin-top:24px;font-size:12px;color:#888">
        このメールは UMA BizFlow LP のお問い合わせフォームから自動送信されました。
      </p>
    </body>
    </html>
  `;

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
      to:   [process.env.NOTIFY_EMAIL     || 'change-me@example.com'],
      subject,
      html,
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Resend error:', err);
    return res.status(500).json({ error: '送信中にエラーが発生しました' });
  }
};
